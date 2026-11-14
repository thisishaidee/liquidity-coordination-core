import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useWrappedReownAdapter } from "@jup-ag/jup-mobile-adapter";
import { Connection, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
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
      async prepareX402Payment(requirement, expectedAddress) {
        const address = adapter.publicKey?.toBase58?.() || "";
        if (!adapter.connected || address !== expectedAddress) {
          throw new Error("The active Jupiter Mobile session does not match the registered x402 payment wallet.");
        }
        if (typeof adapter.signTransaction !== "function") {
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
        const message = new TransactionMessage({
          payerKey: feePayer,
          recentBlockhash: latest.blockhash,
          instructions
        }).compileToV0Message();
        const preparationId = crypto.randomUUID();
        const expiresAt = Date.now() + Math.max(0, requirement.maxTimeoutSeconds - 15) * 1000;
        preparedX402Transactions.set(preparationId, {
          transaction: new VersionedTransaction(message),
          address,
          expiresAt
        });
        return { preparationId, expiresAt };
      },
      async signPreparedX402Payment(preparationId, expectedAddress) {
        const address = adapter.publicKey?.toBase58?.() || "";
        const prepared = preparedX402Transactions.get(preparationId);
        if (!prepared) throw new Error("The prepared x402 payment is missing. Request a fresh quote challenge.");
        if (!adapter.connected || address !== expectedAddress || address !== prepared.address) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("Reconnect Jupiter Mobile to the selected x402 payment wallet, then request a fresh quote.");
        }
        if (Date.now() >= prepared.expiresAt) {
          preparedX402Transactions.delete(preparationId);
          throw new Error("The x402 payment challenge expired. Request a fresh quote before signing.");
        }
        const signed = await adapter.signTransaction(prepared.transaction);
        preparedX402Transactions.delete(preparationId);
        const bytes = signed.serialize();
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
    window.dispatchEvent(new CustomEvent("nerith:jupiter-ready"));
    return () => {
      if (window.NERITHJUPITER === api) delete window.NERITHJUPITER;
    };
  }, [jupiterAdapter]);

  return null;
}

const mount = document.getElementById("jupiterWalletMount");
if (mount) createRoot(mount).render(React.createElement(JupiterMobileBridge));
