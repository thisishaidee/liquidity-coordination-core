import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";

const MAINNET_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
let universalProvider;
let solanaProvider;

async function initialize() {
  if (universalProvider) return universalProvider;
  universalProvider = await OKXUniversalProvider.init({
    dappMetaData: {
      name: "NERITH",
      icon: "https://neritth.pages.dev/favicon.ico"
    }
  });
  solanaProvider = new OKXSolanaProvider(universalProvider);
  return universalProvider;
}

async function connect() {
  const provider = universalProvider || await initialize();
  if (!provider.connected()) {
    await provider.connect({
      namespaces: {
        solana: {
          chains: [MAINNET_CHAIN],
          defaultChain: MAINNET_CHAIN
        }
      }
    });
  }
  const account = solanaProvider.getAccount(MAINNET_CHAIN);
  if (!account?.address) throw new Error("OKX Wallet connected without returning a Solana address.");
  window.NERITHOKX_CONNECTED_ADDRESS = account.address;
  return account.address;
}

async function signMessage(message, expectedAddress) {
  const provider = universalProvider || await initialize();
  if (!provider.connected()) throw new Error("OKX Wallet session is not connected. Reconnect and try again.");
  const account = solanaProvider.getAccount(MAINNET_CHAIN);
  if (!account?.address || account.address !== expectedAddress) {
    throw new Error("The connected OKX account does not match the registered wallet address.");
  }
  const signed = await solanaProvider.signMessage(message, MAINNET_CHAIN);
  if (signed?.publicKey !== expectedAddress) throw new Error("OKX Wallet signed with a different account.");
  const signature = signed?.signature;
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    throw new Error("OKX Wallet returned an unsupported message-signature format.");
  }
  return signature;
}
async function signTransaction(transaction, expectedAddress) {
  const provider = universalProvider || await initialize();
  if (!provider.connected()) throw new Error("OKX Wallet session is not connected. Reconnect and try again.");
  const account = solanaProvider.getAccount(MAINNET_CHAIN);
  if (!account?.address || account.address !== expectedAddress) {
    throw new Error("The connected OKX account does not match the selected x402 payment wallet.");
  }
  const signed = await solanaProvider.signTransaction(transaction, MAINNET_CHAIN);
  if (!signed || typeof signed.serialize !== "function") {
    throw new Error("OKX Wallet did not return a signed Solana transaction.");
  }
  return signed;
}

window.NERITHOKX = Object.freeze({ initialize, connect, signMessage, signTransaction, get connected() { return Boolean(universalProvider?.connected()); }, getAddress() { return universalProvider?.connected() ? solanaProvider.getAccount(MAINNET_CHAIN)?.address || "" : ""; } });
