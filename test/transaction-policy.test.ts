import { describe, expect, it } from "vitest";
import {
  evaluatePaymentIntentPolicy,
  type PaymentIntent,
  type PaymentPolicy,
  type PolicyWalletSnapshot
} from "../src/transaction-policy";

const now = Date.parse("2026-11-14T08:00:00.000Z");
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const DESTINATION = "Recipient111111111111111111111111111111111";

function intent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  return {
    operationId: "op_12345678",
    idempotencyKey: "idem_12345678",
    businessId: "biz_a",
    destination: DESTINATION,
    mint: MINT,
    amountAtoms: "5000000",
    createdAt: new Date(now - 30_000).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    allowPartialPayment: false,
    networkFeeLamports: "5000",
    networkFeePayerWalletId: "wallet_payment",
    ...overrides
  };
}

function policy(overrides: Partial<PaymentPolicy> = {}): PaymentPolicy {
  return {
    businessId: "biz_a",
    allowedMints: [MINT],
    allowedDestinations: [DESTINATION],
    allowedConversionMints: ["So11111111111111111111111111111111111111112"],
    maxTransactionAtoms: "10000000",
    maxNetworkFeeLamports: "10000",
    allowedFeePayerWalletIds: ["wallet_payment"],
    maxDailyAtoms: "20000000",
    committedTodayAtoms: "0",
    maxBalanceAgeSeconds: 300,
    maxIntentLifetimeSeconds: 600,
    maxSlippageBps: 100,
    allowConversion: false,
    allowPartialPayment: false,
    ...overrides
  };
}

function wallet(overrides: Partial<PolicyWalletSnapshot> = {}): PolicyWalletSnapshot {
  return {
    walletId: "wallet_payment",
    businessId: "biz_a",
    scope: "business",
    status: "active",
    role: "payment",
    enabled: true,
    ownershipVerifiedAt: new Date(now - 60_000).toISOString(),
    mint: MINT,
    confirmedAtoms: "10000000",
    reservedAtoms: "0",
    observedAt: new Date(now - 20_000).toISOString(),
    ...overrides
  };
}

function evaluate(
  paymentIntent: PaymentIntent,
  paymentPolicy: PaymentPolicy,
  snapshots: PolicyWalletSnapshot[],
  nowMs = now
) {
  const feePayerExists = snapshots.some(snapshot =>
    snapshot.walletId === paymentIntent.networkFeePayerWalletId && snapshot.mint === "SOL"
  );
  const feePayer = feePayerExists ? [] : [wallet({
    walletId: paymentIntent.networkFeePayerWalletId,
    role: "payment",
    mint: "SOL",
    confirmedAtoms: "100000",
    reservedAtoms: "0"
  })];
  return evaluatePaymentIntentPolicy(paymentIntent, paymentPolicy, [...snapshots, ...feePayer], nowMs);
}

describe("deterministic payment intent policy", () => {
  it("allows direct payment from one verified, fresh payment wallet", () => {
    const result = evaluate(intent(), policy(), [wallet()], now);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.action).toBe("direct_payment");
      expect(result.paymentWalletId).toBe("wallet_payment");
      expect(result.paymentAmountAtoms).toBe(5_000_000n);
      expect(result.replenishmentPlan.legs).toEqual([]);
      expect(result.requiresSignerAuthorization).toBe(true);
    }
  });

  it("plans reserve replenishment while preserving reserve floors and transfer caps", () => {
    const payment = wallet({ confirmedAtoms: "3000000" });
    const reserve = wallet({
      walletId: "wallet_reserve",
      role: "reserve",
      confirmedAtoms: "10000000",
      minimumRemainingAtoms: "2000000",
      maximumTransferAtoms: "5000000"
    });
    const result = evaluate(intent({ amountAtoms: "7000000" }), policy(), [payment, reserve], now);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.action).toBe("replenish_then_pay");
      expect(result.replenishmentPlan.legs).toEqual([{ sourceWalletId: "wallet_reserve", amountAtoms: 4_000_000n }]);
    }
  });

  it("does not double-count a wallet assigned both operating and reserve roles", () => {
    const payment = wallet({ confirmedAtoms: "1000000" });
    const shared = wallet({
      walletId: "wallet_shared",
      role: "operating",
      confirmedAtoms: "4000000",
      minimumRemainingAtoms: "0"
    });
    const sharedReserve = { ...shared, role: "reserve" as const, minimumRemainingAtoms: "1000000" };
    const result = evaluate(intent(), policy(), [payment, shared, sharedReserve], now);
    expect(result.eligible).toBe(false);
    if (!result.eligible) expect(result.code).toBe("insufficient_authorized_usdc");
  });

  it("rejects missing, disabled, unverified or duplicate payment wallet assignments", () => {
    const missing = evaluate(intent(), policy(), [], now);
    const disabled = evaluate(intent(), policy(), [wallet({ enabled: false })], now);
    const unverified = evaluate(intent(), policy(), [wallet({ ownershipVerifiedAt: null })], now);
    const duplicate = evaluate(intent(), policy(), [wallet(), wallet({ walletId: "wallet_payment_2" })], now);
    expect(missing).toMatchObject({ eligible: false, code: "payment_wallet_configuration_invalid" });
    expect(disabled).toMatchObject({ eligible: false, code: "payment_wallet_configuration_invalid" });
    expect(unverified).toMatchObject({ eligible: false, code: "payment_wallet_unverified" });
    expect(duplicate).toMatchObject({ eligible: false, code: "payment_wallet_configuration_invalid" });
  });

  it("rejects destinations and mints outside explicit allowlists", () => {
    expect(evaluate(intent({ destination: "not-allowed" }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "destination_not_allowed" });
    expect(evaluate(intent({ mint: "fake-usdc" }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "mint_not_allowed" });
  });

  it("enforces transaction and daily committed-spend limits", () => {
    expect(evaluate(intent({ amountAtoms: "11000000" }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "per_transaction_limit_exceeded" });
    expect(evaluate(intent(), policy({ committedTodayAtoms: "16000000" }), [wallet()], now))
      .toMatchObject({ eligible: false, code: "daily_limit_exceeded" });
  });

  it("rejects stale payment balances and inconsistent reserved amounts", () => {
    expect(evaluate(intent(), policy(), [wallet({ observedAt: new Date(now - 600_000).toISOString() })], now))
      .toMatchObject({ eligible: false, code: "payment_balance_stale" });
    expect(evaluate(intent(), policy(), [wallet({ confirmedAtoms: "100", reservedAtoms: "200" })], now))
      .toMatchObject({ eligible: false, code: "payment_balance_invalid" });
  });

  it("requires explicit conversion permission and leaves conversion owner-approved", () => {
    const payment = wallet({ confirmedAtoms: "2000000" });
    const reserve = wallet({
      walletId: "wallet_reserve",
      role: "reserve",
      confirmedAtoms: "2000000",
      maximumTransferAtoms: "1000000"
    });
    const solReserve = wallet({
      walletId: "wallet_sol_reserve",
      role: "reserve",
      mint: "So11111111111111111111111111111111111111112",
      confirmedAtoms: "1000000000",
      minimumRemainingAtoms: "100000000",
      maximumTransferAtoms: "500000000"
    });
    const result = evaluate(intent({ slippageBps: 50 }), policy({ allowConversion: true }), [payment, reserve, solReserve], now);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.action).toBe("conversion_required");
      expect(result.conversionShortfallAtoms).toBe(2_000_000n);
      expect(result.ownerApprovalRequired).toBe(true);
      expect(result.conversionSourceWallets).toEqual([{ walletId: "wallet_sol_reserve", mint: "So11111111111111111111111111111111111111112", availableAtoms: 500_000_000n }]);
    }
  });

  it("rejects estimated network fees above the business cap", () => {
    expect(evaluate(intent({ networkFeeLamports: "10001" }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "network_fee_limit_exceeded" });
  });

  it("requires an approved conversion asset and slippage before returning conversion_required", () => {
    const payment = wallet({ confirmedAtoms: "2000000" });
    const noSource = evaluate(intent({ slippageBps: 50 }), policy({ allowConversion: true }), [payment], now);
    const noSlippage = evaluate(
      intent(),
      policy({ allowConversion: true }),
      [payment, wallet({ walletId: "sol", role: "reserve", mint: "So11111111111111111111111111111111111111112", confirmedAtoms: "1000000000" })],
      now
    );
    expect(noSource).toMatchObject({ eligible: false, code: "no_authorized_conversion_source" });
    expect(noSlippage).toMatchObject({ eligible: false, code: "conversion_slippage_required" });
  });

  it("allows partial payment only when both intent and business policy enable it", () => {
    const payment = wallet({ confirmedAtoms: "2000000" });
    const result = evaluate(
      intent({ allowPartialPayment: true }),
      policy({ allowPartialPayment: true }),
      [payment],
      now
    );
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.action).toBe("partial_payment");
      expect(result.paymentAmountAtoms).toBe(2_000_000n);
      expect(result.unpaidAtoms).toBe(3_000_000n);
    }
  });

  it("excludes API fee, receiving, unverified and cross-business wallets as funding sources", () => {
    const payment = wallet({ confirmedAtoms: "1000000" });
    const excluded = [
      wallet({ walletId: "api", role: "api_payment", confirmedAtoms: "10000000" }),
      wallet({ walletId: "receiver", role: "receiving", confirmedAtoms: "10000000" }),
      wallet({ walletId: "unverified", role: "reserve", ownershipVerifiedAt: null, confirmedAtoms: "10000000" }),
      wallet({ walletId: "other_business", role: "reserve", businessId: "biz_other", confirmedAtoms: "10000000" })
    ];
    const result = evaluate(intent(), policy(), [payment, ...excluded], now);
    expect(result).toMatchObject({ eligible: false, code: "insufficient_authorized_usdc" });
  });

  it("rejects expired intents, invalid idempotency keys and excess slippage", () => {
    expect(evaluate(intent({ expiresAt: new Date(now - 1).toISOString() }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "intent_expired_or_invalid" });
    expect(evaluate(intent({ idempotencyKey: "x" }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "invalid_operation_identity" });
    expect(evaluate(intent({ slippageBps: 101 }), policy(), [wallet()], now))
      .toMatchObject({ eligible: false, code: "slippage_limit_exceeded" });
  });
});
