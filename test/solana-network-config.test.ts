import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getSolanaNetworkConfig } from "../src/solana-network-config";

describe("Solana network configuration", () => {
  it("defaults to canonical Solana mainnet CAIP-2", () => {
    expect(getSolanaNetworkConfig()).toEqual({
      cluster: "mainnet",
      chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    });
  });

  it("resolves the isolated devnet chain identifier", () => {
    expect(getSolanaNetworkConfig("devnet")).toEqual({
      cluster: "devnet",
      chainId: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
    });
  });

  it("normalizes configured cluster names and rejects unknown clusters", () => {
    expect(getSolanaNetworkConfig(" DEVNET ").cluster).toBe("devnet");
    expect(() => getSolanaNetworkConfig("localnet")).toThrow("unsupported_solana_cluster");
  });
});

describe("wallet challenge network migration", () => {
  it("converts the legacy mainnet label and permits only canonical mainnet/devnet chain IDs", () => {
    const migration = readFileSync("migrations/0033_canonical_solana_wallet_challenge_networks.sql", "utf8");
    expect(migration).toContain("WHEN 'solana:mainnet-beta' THEN 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'");
    expect(migration).toContain("'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'");
    expect(migration).toContain("'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'");
    expect(migration).toContain("DROP TABLE wallet_ownership_challenges");
  });
});
