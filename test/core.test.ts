import { describe, expect, it } from "vitest";
import { evaluateLiquidity, formatTokenAmount, parseTokenAmount, planUsdcReplenishment } from "../src/core";


describe("multi-wallet USDC replenishment planning", () => {
  it("does not plan a transfer when the payment wallet already covers the request", () => {
    const plan = planUsdcReplenishment("payment", 800n, 900n, [
      { walletId: "reserve", availableAtoms: 5_000n, eligible: true }
    ]);
    expect(plan.status).toBe("covered");
    expect(plan.shortfallAtoms).toBe(0n);
    expect(plan.legs).toEqual([]);
  });

  it("chooses the smallest single eligible reserve that covers the shortfall", () => {
    const plan = planUsdcReplenishment("payment", 800n, 300n, [
      { walletId: "large", availableAtoms: 2_000n, eligible: true },
      { walletId: "best-fit", availableAtoms: 700n, eligible: true },
      { walletId: "not-authorized", availableAtoms: 900n, eligible: false },
      { walletId: "payment", availableAtoms: 9_000n, eligible: true }
    ]);
    expect(plan.status).toBe("covered");
    expect(plan.shortfallAtoms).toBe(500n);
    expect(plan.legs).toEqual([{ sourceWalletId: "best-fit", amountAtoms: 500n }]);
  });

  it("splits a shortfall across eligible reserves while preserving reserve floors", () => {
    const plan = planUsdcReplenishment("payment", 1_000n, 200n, [
      { walletId: "reserve-a", availableAtoms: 600n, minimumRemainingAtoms: 200n, eligible: true },
      { walletId: "reserve-b", availableAtoms: 500n, minimumRemainingAtoms: 100n, eligible: true }
    ]);
    expect(plan.status).toBe("covered");
    expect(plan.shortfallAtoms).toBe(800n);
    expect(plan.legs).toEqual([
      { sourceWalletId: "reserve-a", amountAtoms: 400n },
      { sourceWalletId: "reserve-b", amountAtoms: 400n }
    ]);
    expect(plan.totalPlannedAtoms).toBe(800n);
  });

  it("reports a partial plan without pretending the shortfall is funded", () => {
    const plan = planUsdcReplenishment("payment", 1_000n, 100n, [
      { walletId: "reserve-a", availableAtoms: 300n, minimumRemainingAtoms: 100n, eligible: true },
      { walletId: "reserve-b", availableAtoms: 500n, minimumRemainingAtoms: 400n, eligible: true }
    ]);
    expect(plan.status).toBe("insufficient_authorized_usdc");
    expect(plan.totalPlannedAtoms).toBe(300n);
    expect(plan.legs).toEqual([{ sourceWalletId: "reserve-a", amountAtoms: 200n }]);
  });

  it("honours per-source transfer caps and rejects invalid amounts", () => {
    const plan = planUsdcReplenishment("payment", 700n, 200n, [
      { walletId: "reserve", availableAtoms: 2_000n, maximumTransferAtoms: 250n, eligible: true }
    ]);
    expect(plan.status).toBe("insufficient_authorized_usdc");
    expect(plan.totalPlannedAtoms).toBe(250n);
    expect(() => planUsdcReplenishment("payment", 0n, 0n, [])).toThrow();
  });
});

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
