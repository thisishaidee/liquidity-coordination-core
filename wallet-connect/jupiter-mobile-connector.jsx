import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useWrappedReownAdapter } from "@jup-ag/jup-mobile-adapter";

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
