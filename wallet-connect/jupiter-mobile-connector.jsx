import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useWrappedReownAdapter } from "@jup-ag/jup-mobile-adapter";
import { Connection, ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const REOWN_PROJECT_ID = "13a7a3c0065f86dab70a544edc8ed07d";
const MAINNET_ADDRESS_PREFIX = "solana:";
const preparedX402Transactions = new Map();

function JupiterMobileBridge() {
  const { jupiterAdapter } = useWrappedReownAdapter({
    appKitOptions: {
      metadata: {
        name: "NERITH",
        description: "Connect and verify a business-controlled Solana wallet",
        url: window.location.origin,
        icons: [new URL("/favicon.ico", window.location.origin).toString()]
      },
      projectId: REOWN_PROJECT_ID,
      features: {
        analytics: false,
        socials: [],
        email: false
      },
      enableWallets: false
    }
  });

  useEffect(() => {
    if (!jupiterAdapter) return;
    const adapter = jupiterAdapter;
    const api = Object.freeze({
      async connect() {
        await adapter.connect();
        const address = adapter.publicKey?.toBase58?.() || "";
        if (!address) throw new Error("Jupiter Mobile connected without returning a Solana address.");
        return address;
      },
      getAddress() {
        return adapter.publicKey?.toBase58?.() || "";
      },
      get connected() {
        return Boolean(adapter.connected && adapter.publicKey);
      },
      async signMessage(message, expectedAddress) {
        const address = adapter.publicKey?.toBase58?.() || "";
        if (!adapter.connected || address !== expectedAddress) {
          throw new Error("The active Jupiter Mobile session does not match the registered wallet address. Reconnect the same account and try again.");
        }
        if (typeof adapter.signMessage !== "function") {
          throw new Error("Jupiter Mobile did not expose message signing for this session.");
        }
        const signature = await adapter.signMessage(new TextEncoder().encode(message));
        if (!(signature instanceof Uint8Array) || signature.length !== 64) {
          throw new Error("Jupiter Mobile returned an unsupported message-signature format.");
        }
        return signature;
      },
      async prepareX402Payment(requirement, expectedAddress, signer = { kind: "jupiter" }) {
        const address = expectedAddress;
        if (signer.kind === "jupiter" && (!adapter.connected || adapter.publicKey?.toBase58?.() !== expectedAddress)) {
          throw new Error("The active Jupiter Mobile session does not match the registered x402 payment wallet.");
        }
        if (signer.kind === "okx" && (!window.NERITHOKX?.connected || window.NERITHOKX.getAddress() !== expectedAddress)) {
          throw new Error("The active OKX session does not match the registered x402 payment wallet.");
        }
        if (signer.kind === "injected" && signer.provider?.publicKey?.toString?.() !== expectedAddress) {
          throw new Error("The selected injected wallet account changed. Reconnect and request a fresh quote.");
        }
        if (signer.kind === "standard" && (!signer.account || signer.account.address !== expectedAddress ||
            !signer.wallet?.features?.["solana:signTransaction"]?.signTransaction)) {
          throw new Error("The selected Wallet Standard account cannot sign Solana transactions.");
        }
        if (!["jupiter", "okx", "injected", "standard"].includes(signer.kind)) {
          throw new Error("Unsupported Solana wallet signing method.");
        }
        if (signer.kind === "jupiter" && typeof adapter.signTransaction !== "function") {
          throw new Error("Jupiter Mobile did not expose transaction signing for this session.");
        }
        if (!requirement || requirement.scheme !== "exact" || requirement.network !== "solana" ||
            requirement.resource !== "https://hermes.swap.io/v1/swap/quote" ||
            typeof requirement.maxTimeoutSeconds !== "number" || requirement.maxTimeoutSeconds < 1 || requirement.maxTimeoutSeconds > 120 ||
            requirement.asset !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ||
            !/^\d{1,18}$/.test(String(requirement.maxAmountRequired || "")) ||
            BigInt(requirement.maxAmountRequired) <= 0n || BigInt(requirement.maxAmountRequired) > 10000n ||
            !requirement.payTo || !requirement.extra?.feePayer) {
          throw new Error("Swap.io returned an unsupported or incomplete Solana USDC payment requirement.");
        }
        if (address === requirement.payTo || address === requirement.extra.feePayer) {
          throw new Error("The x402 payment wallet must be distinct from Swap.io recipient and facilitator fee payer.");
        }
        const payer = new PublicKey(address);
        const mint = new PublicKey(requirement.asset);
        const recipient = new PublicKey(requirement.payTo);
        const feePayer = new PublicKey(requirement.extra.feePayer);
        const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
        const sourceAta = getAssociatedTokenAddressSync(mint, payer);
        const destinationAta = getAssociatedTokenAddressSync(mint, recipient, true);
        const sourceInfo = await connection.getAccountInfo(sourceAta, "confirmed");
        if (!sourceInfo) throw new Error("This Jupiter account has no Solana USDC token account.");
        const sourceBalance = await connection.getTokenAccountBalance(sourceAta, "confirmed");
        if (BigInt(sourceBalance.value.amount) < BigInt(requirement.maxAmountRequired)) {
          throw new Error("This Jupiter account does not have enough USDC to pay the exact x402 API fee.");
        }
        const destinationInfo = await connection.getAccountInfo(destinationAta, "confirmed");
        if (!destinationInfo) throw new Error("Swap.io's USDC receiving account is not initialized; refusing to add extra instructions to the x402 payment.");
        const instructions = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
          createTransferCheckedInstruction(
            sourceAta, mint, destinationAta, payer, BigInt(requirement.maxAmountRequired), 6
          )
        ];
        const latest = await connection.getLatestBlockhash("confirmed");
        const transaction = new Transaction({
          feePayer,
          recentBlockhash: latest.blockhash
        }).add(...instructions);
        const preparationId = crypto.randomUUID();
        const expiresAt = Date.now() + Math.max(0, requirement.maxTimeoutSeconds - 15) * 1000;
        preparedX402Transactions.set(preparationId, {
          transaction,
          address,
          signer,
          expiresAt
        });
        return { preparationId, expiresAt };
      },
      async signPreparedX402Payment(preparationId, expectedAddress, signer = { kind: "jupiter" }) {
        const prepared = preparedX402Transactions.get(preparationId);
        if (!prepared) throw new Error("The prepared x402 payment is missing. Request a fresh quote challenge.");
        if (expectedAddress !== prepared.address || signer.kind !== prepared.signer.kind) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("The selected wallet changed after the x402 quote. Request a fresh challenge.");
        }
        if (signer.kind === "jupiter" && (!adapter.connected || adapter.publicKey?.toBase58?.() !== expectedAddress)) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("Reconnect Jupiter Mobile to the selected x402 payment wallet, then request a fresh quote.");
        }
        if (signer.kind === "okx" && (!window.NERITHOKX?.connected || window.NERITHOKX.getAddress() !== expectedAddress)) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("Reconnect OKX Wallet to the selected x402 payment wallet, then request a fresh quote.");
        }
        if (signer.kind === "injected" && signer.provider?.publicKey?.toString?.() !== expectedAddress) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("The injected wallet account changed. Reconnect and request a fresh quote.");
        }
        if (signer.kind === "standard" && (!signer.account || signer.account.address !== expectedAddress ||
            !signer.wallet?.features?.["solana:signTransaction"]?.signTransaction)) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("The selected Wallet Standard account is no longer available.");
        }
        if (Date.now() >= prepared.expiresAt) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("The x402 payment challenge expired. Request a fresh quote before signing.");
        }
        let signed;
        if (signer.kind === "jupiter") {
          signed = await adapter.signTransaction(prepared.transaction);
        } else if (signer.kind === "okx") {
          signed = await window.NERITHOKX.signTransaction(prepared.transaction, expectedAddress);
        } else if (signer.kind === "injected") {
          if (typeof signer.provider.signTransaction !== "function") throw new Error("This injected wallet does not support signing a prepared transaction.");
          signed = await signer.provider.signTransaction(prepared.transaction);
        } else {
          const feature = signer.wallet.features["solana:signTransaction"];
          const serialized = new Uint8Array(prepared.transaction.serialize({
            requireAllSignatures: false,
            verifySignatures: false
          }));
          const result = await feature.signTransaction({
            account: signer.account,
            transaction: serialized,
            chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
          });
          const signedBytes = result?.signedTransaction || result?.[0]?.signedTransaction || result?.[0];
          if (!(signedBytes instanceof Uint8Array)) throw new Error("Wallet Standard did not return signed transaction bytes.");
          signed = Transaction.from(signedBytes);
        }
        if (!signed || typeof signed.serialize !== "function") throw new Error("The selected wallet did not return a signed Solana transaction.");
        const userSignature = signed.signatures?.find(item => item.publicKey?.toBase58?.() === expectedAddress)?.signature;
        if (!(userSignature instanceof Uint8Array) || userSignature.every(byte => byte === 0)) {
          throw new Error("The selected wallet returned a transaction without the expected USDC transfer-authority signature.");
        }
        preparedX402Transactions.delete(preparationId);
        const bytes = signed.serialize({ requireAllSignatures: false, verifySignatures: false });
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        const envelope = {
          x402Version: 1,
          scheme: "exact",
          network: "solana",
          payload: { transaction: btoa(binary) }
        };
        return btoa(JSON.stringify(envelope));
      },
      async disconnect() {
        if (adapter.connected && typeof adapter.disconnect === "function") await adapter.disconnect();
      }
    });
    window.NERITHJUPITER = api;
    window.NERITHSOLANA = api;
    window.dispatchEvent(new CustomEvent("nerith:jupiter-ready"));
    window.dispatchEvent(new CustomEvent("nerith:solana-wallet-signing-ready"));
    return () => {
      if (window.NERITHJUPITER === api) delete window.NERITHJUPITER;
    };
  }, [jupiterAdapter]);

  return null;
}

const mount = document.getElementById("jupiterWalletMount");
if (mount) createRoot(mount).render(React.createElement(JupiterMobileBridge));
