import { OKXUniversalProvider } from "@okxconnect/universal-provider";
import { OKXSolanaProvider } from "@okxconnect/solana-provider";
import { Transaction } from "@solana/web3.js";

const MAINNET_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DEVNET_CHAIN = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
let activeChain = MAINNET_CHAIN;

function setChain(chain) {
  if (chain !== MAINNET_CHAIN && chain !== DEVNET_CHAIN) {
    throw new Error("Unsupported Solana wallet chain.");
  }
  activeChain = chain;
}
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
          chains: [activeChain],
          defaultChain: activeChain
        }
      }
    });
    await connection;
  }
  const account = solanaProvider.getAccount(activeChain);
  if (!account?.address) throw new Error("OKX Wallet connected without returning a Solana address.");
  window.NERITHOKX_CONNECTED_ADDRESS = account.address;
  return account.address;
}

async function signMessage(message, expectedAddress) {
  const provider = universalProvider || await initialize();
  if (!provider.connected()) throw new Error("OKX Wallet session is not connected. Reconnect and try again.");
  const account = solanaProvider.getAccount(activeChain);
  if (!account?.address || account.address !== expectedAddress) {
    throw new Error("The connected OKX account does not match the registered wallet address.");
  }
  const signed = await solanaProvider.signMessage(message, activeChain);
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
  const account = solanaProvider.getAccount(activeChain);
  if (!account?.address || account.address !== expectedAddress) {
    throw new Error("The connected OKX account does not match the selected wallet address.");
  }
  const signed = await solanaProvider.signTransaction(transaction, activeChain);
  if (!signed || typeof signed.serialize !== "function") {
    throw new Error("OKX Wallet did not return a signed Solana transaction.");
  }
  return signed;
}

function hasExpectedSignature(transaction, expectedAddress) {
  const entry = transaction.signatures?.find(item => item.publicKey?.toBase58?.() === expectedAddress);
  return entry?.signature instanceof Uint8Array && entry.signature.some(byte => byte !== 0);
}

function canSignFor(expectedAddress) {
  const injectedAddress = window.okxwallet?.solana?.publicKey?.toString?.() || "";
  const appAddress = universalProvider?.connected() ? solanaProvider?.getAccount(activeChain)?.address || "" : "";
  return injectedAddress === expectedAddress || appAddress === expectedAddress;
}

async function signFundingTransaction(transactionBytes, expectedAddress) {
  if (!(transactionBytes instanceof Uint8Array) || transactionBytes.length < 100 || transactionBytes.length > 16384) {
    throw new Error("The prepared funding transaction bytes are invalid.");
  }
  const transaction = Transaction.from(transactionBytes);
  let signed;
  const injected = window.okxwallet?.solana;
  if (injected?.publicKey?.toString?.() === expectedAddress && typeof injected.signTransaction === "function") {
    signed = await injected.signTransaction(transaction);
  } else {
    signed = await signTransaction(transaction, expectedAddress);
  }
  if (!signed || typeof signed.serialize !== "function" || !hasExpectedSignature(signed, expectedAddress)) {
    throw new Error("OKX Wallet did not return a transaction signed by the required business wallet.");
  }
  return new Uint8Array(signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
}

window.NERITHOKX = Object.freeze({
  initialize, connect, signMessage, signTransaction, signFundingTransaction, canSignFor, setChain,
  get connected() { return Boolean(universalProvider?.connected() || window.okxwallet?.solana?.publicKey); },
  getAddress() { return window.okxwallet?.solana?.publicKey?.toString?.() || (universalProvider?.connected() ? solanaProvider.getAccount(activeChain)?.address || "" : ""); }
});
