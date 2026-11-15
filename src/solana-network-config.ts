export const SOLANA_NETWORKS = Object.freeze({
  mainnet: Object.freeze({
    cluster: "mainnet",
    chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  }),
  devnet: Object.freeze({
    cluster: "devnet",
    chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
  })
});

export type SolanaCluster = keyof typeof SOLANA_NETWORKS;

export function getSolanaNetworkConfig(cluster?: string) {
  const normalized = (cluster || "mainnet").trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(SOLANA_NETWORKS, normalized)) {
    throw new Error("unsupported_solana_cluster");
  }
  return SOLANA_NETWORKS[normalized as SolanaCluster];
}
