import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useWrappedReownAdapter } from "@jup-ag/jup-mobile-adapter";
import { Connection, ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const REOWN_PROJECT_ID = "13a7a3c0065f86dab70a544edc8ed07d";
const MAINNET_ADDRESS_PREFIX = "solana:";

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
      async createX402PaymentHeader(requirement, expectedAddress) {
        const address = adapter.publicKey?.toBase58?.() || "";
        if (!adapter.connected || address !== expectedAddress) {
          throw new Error("The active Jupiter Mobile session does not match the registered x402 payment wallet.");
        }
        if (typeof adapter.signTransaction !== "function") {
          throw new Error("Jupiter Mobile did not expose transaction signing for this session.");
        }
        if (!requirement || requirement.scheme !== "exact" || requirement.network !== "solana" ||
            requirement.asset !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ||
            !/^\d{1,18}$/.test(String(requirement.maxAmountRequired || "")) ||
            !requirement.payTo || !requirement.extra?.feePayer) {
          throw new Error("Swap.io returned an unsupported or incomplete Solana USDC payment requirement.");
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
        const destinationInfo = await connection.getAccountInfo(destinationAta, "confirmed");
        const instructions = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })
        ];
        if (!destinationInfo) {
          instructions.push(createAssociatedTokenAccountIdempotentInstruction(feePayer, destinationAta, recipient, mint));
        }
        instructions.push(createTransferCheckedInstruction(
          sourceAta, mint, destinationAta, payer, BigInt(requirement.maxAmountRequired), 6
        ));
        const latest = await connection.getLatestBlockhash("confirmed");
        const message = new TransactionMessage({
          payerKey: feePayer,
          recentBlockhash: latest.blockhash,
          instructions
        }).compileToV0Message();
        const transaction = new VersionedTransaction(message);
        const signed = await adapter.signTransaction(transaction);
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
