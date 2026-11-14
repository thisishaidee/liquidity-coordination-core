import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";

const MAINNET_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
let universalProvider;
let solanaProvider;
let initializationPromise;

async function initialize() {
  if (universalProvider && solanaProvider) return universalProvider;
  if (!initializationPromise) {
    initializationPromise = OKXUniversalProvider.init({
      dappMetaData: {
        name: "NERITH",
        icon: "https://neritth.pages.dev/favicon.ico"
      }
    }).then(provider => {
      universalProvider = provider;
      solanaProvider = new OKXSolanaProvider(provider);
      return provider;
    }).catch(error => {
      initializationPromise = undefined;
      throw error;
    });
  }
  return initializationPromise;
}

async function connect() {
  // Initialize during dashboard startup, not inside the click handler. Waiting
  // here would consume Android's transient user gesture before OKX can launch.
  const provider = universalProvider;
  if (!provider || !solanaProvider) {
    throw new Error("OKX Wallet is still initializing. Wait for the dashboard to finish loading, then retry.");
  }
  if (!provider.connected()) {
    const connection = provider.connect({
      namespaces: {
        solana: {
          chains: [MAINNET_CHAIN],
          defaultChain: MAINNET_CHAIN
        }
      }
    });
    await connection;
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
