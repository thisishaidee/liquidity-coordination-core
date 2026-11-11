import { describe, expect, it } from "vitest";
import { evaluateLiquidity, formatTokenAmount, parseTokenAmount } from "../src/core";

describe("amount precision", () => {
  it("parses USDC amounts into exact six-decimal atoms", () => {
    expect(parseTokenAmount("10")).toBe(10_000_000n);
    expect(parseTokenAmount("0.000001")).toBe(1n);
    expect(parseTokenAmount("0.1", 9)).toBe(100_000_000n);
    expect(formatTokenAmount(8_250_000n)).toBe("8.25");
    expect(formatTokenAmount(100_000_000n, 9)).toBe("0.1");
  });

  it("rejects non-string, zero, negative and excessive precision amounts", () => {
    expect(() => parseTokenAmount(10)).toThrow();
    expect(() => parseTokenAmount("1.0000001")).toThrow();
    expect(() => parseTokenAmount("0")).toThrow();
    expect(() => parseTokenAmount("-1")).toThrow();
  });
});

describe("liquidity decisions", () => {
  it("allows direct fulfillment when one authorized wallet covers the request", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 12_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("direct_fulfillment");
    expect(result.shortfallAtoms).toBe(0n);
    expect(result.sourceWalletId).toBe("w1");
  });

  it("chooses a single wallet that can cover the full request", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 5_000_000n, eligible: true },
      { walletId: "w2", token: "USDC", availableAtoms: 15_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("direct_fulfillment");
    expect(result.sourceWalletId).toBe("w2");
    expect(result.availableAtoms).toBe(15_000_000n);
  });

  it("does not aggregate separate wallets before split reservations are implemented", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 6_000_000n, eligible: true },
      { walletId: "w2", token: "USDC", availableAtoms: 6_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("insufficient_authorized_funds");
    expect(result.availableAtoms).toBe(6_000_000n);
  });

  it("detects a conversion path when an eligible alternative token exists", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 2_000_000n, eligible: true },
      { walletId: "w1", token: "SOL", availableAtoms: 500_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("conversion_required");
    expect(result.shortfallAtoms).toBe(8_000_000n);
    expect(result.eligibleSourceTokens).toEqual(["SOL"]);
    expect(result.sourceWalletId).toBe("w1");
  });

  it("does not combine USDC and SOL from different wallets", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 2_000_000n, eligible: true },
      { walletId: "w2", token: "SOL", availableAtoms: 500_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("conversion_required");
    expect(result.availableAtoms).toBe(0n);
    expect(result.shortfallAtoms).toBe(10_000_000n);
    expect(result.sourceWalletId).toBe("w2");
  });

  it("ignores unauthorized balances", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 50_000_000n, eligible: false }
    ]);
    expect(result.action).toBe("insufficient_authorized_funds");
    expect(result.availableAtoms).toBe(0n);
  });

  it("does not count amounts already reserved", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 4_000_000n, eligible: true }
    ]);
    expect(result.shortfallAtoms).toBe(6_000_000n);
  });
});
