import { describe, expect, it } from "vitest";
import { getSolanaNetworkConfig } from "../src/solana-network-config";

describe("Solana network configuration", () => {
  it("defaults to canonical Solana mainnet CAIP-2", () => {
    expect(getSolanaNetworkConfig()).toEqual({
      cluster: "mainnet",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    });
  });

  it("resolves the isolated devnet chain identifier", () => {
    expect(getSolanaNetworkConfig("devnet")).toEqual({
      cluster: "devnet",
      chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    });
  });

  it("normalizes configured cluster names and rejects unknown clusters", () => {
    expect(getSolanaNetworkConfig(" DEVNET ").cluster).toBe("devnet");
    expect(() => getSolanaNetworkConfig("localnet")).toThrow("unsupported_solana_cluster");
  });
});
