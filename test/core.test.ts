import { describe, expect, it } from "vitest";
import { evaluateLiquidity, formatTokenAmount, parseTokenAmount } from "../src/core";

describe("amount precision", () => {
  it("parses USDC amounts into exact six-decimal atoms", () => {
    expect(parseTokenAmount("10")).toBe(10_000_000n);
    expect(parseTokenAmount("0.000001")).toBe(1n);
    expect(formatTokenAmount(8_250_000n)).toBe("8.25");
  });

  it("rejects floating point numbers and excessive precision", () => {
    expect(() => parseTokenAmount(10)).toThrow();
    expect(() => parseTokenAmount("1.0000001")).toThrow();
    expect(() => parseTokenAmount("0")).toThrow();
  });
});

describe("liquidity decisions", () => {
  it("chooses direct fulfillment when authorized target-token liquidity is enough", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 12_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("direct_fulfillment");
    expect(result.shortfallAtoms).toBe(0n);
  });

  it("detects a conversion path when another authorized token exists", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 2_000_000n, eligible: true },
      { walletId: "w2", token: "SOL", availableAtoms: 500_000_000n, eligible: true }
    ]);
    expect(result.action).toBe("conversion_required");
    expect(result.shortfallAtoms).toBe(8_000_000n);
    expect(result.eligibleSourceTokens).toEqual(["SOL"]);
  });

  it("does not count unauthorized balances", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 50_000_000n, eligible: false }
    ]);
    expect(result.action).toBe("insufficient_authorized_funds");
    expect(result.availableAtoms).toBe(0n);
  });

  it("does not count reserved amounts when net availability is supplied", () => {
    const result = evaluateLiquidity("USDC", 10_000_000n, [
      { walletId: "w1", token: "USDC", availableAtoms: 4_000_000n, eligible: true }
    ]);
    expect(result.shortfallAtoms).toBe(6_000_000n);
  });
});
