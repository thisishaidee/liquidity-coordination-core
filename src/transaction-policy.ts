import { planUsdcReplenishment, type ReplenishmentPlan, type ReplenishmentSource } from "./core";

export type PaymentWalletRole = "payment" | "reserve" | "operating" | "receiving" | "api_payment";

export type PolicyWalletSnapshot = {
  walletId: string;
  businessId: string;
  scope: string;
  status: string;
  role: PaymentWalletRole;
  enabled: boolean;
  ownershipVerifiedAt: string | null;
  mint: string;
  confirmedAtoms: string;
  reservedAtoms: string;
  observedAt: string;
  minimumRemainingAtoms?: string;
  maximumTransferAtoms?: string | null;
};

export type PaymentIntent = {
  operationId: string;
  idempotencyKey: string;
  businessId: string;
  destination: string;
  mint: string;
  amountAtoms: string;
  createdAt: string;
  expiresAt: string;
  allowPartialPayment: boolean;
  slippageBps?: number | null;
  networkFeeLamports: string;
  networkFeePayerWalletId: string;
};

export type PaymentPolicy = {
  businessId: string;
  allowedMints: string[];
  allowedDestinations: string[];
  allowedConversionMints: string[];
  maxTransactionAtoms: string;
  maxNetworkFeeLamports: string;
  allowedFeePayerWalletIds: string[];
  maxDailyAtoms: string;
  committedTodayAtoms: string;
  maxBalanceAgeSeconds: number;
  maxIntentLifetimeSeconds: number;
  maxSlippageBps: number;
  allowConversion: boolean;
  allowPartialPayment: boolean;
};

export type PaymentPolicyDecision =
  | {
      eligible: true;
      action: "direct_payment" | "replenish_then_pay";
      paymentWalletId: string;
      feePayerWalletId: string;
      paymentAmountAtoms: bigint;
      paymentWalletAvailableAtoms: bigint;
      replenishmentPlan: ReplenishmentPlan;
      requiresSignerAuthorization: true;
      ownerApprovalRequired: false;
    }
  | {
      eligible: true;
      action: "conversion_required";
      paymentWalletId: string;
      feePayerWalletId: string;
      requestedAtoms: bigint;
      policyPermittedAtoms: bigint;
      unpaidByPolicyAtoms: bigint;
      paymentWalletAvailableAtoms: bigint;
      replenishmentPlan: ReplenishmentPlan;
      conversionShortfallAtoms: bigint;
      conversionSourceWallets: Array<{ walletId: string; mint: string; availableAtoms: bigint }>;
      requiresSignerAuthorization: true;
      ownerApprovalRequired: true;
    }
  | {
      eligible: true;
      action: "partial_payment";
      paymentWalletId: string;
      feePayerWalletId: string;
      requestedAtoms: bigint;
      paymentAmountAtoms: bigint;
      unpaidAtoms: bigint;
      paymentWalletAvailableAtoms: bigint;
      replenishmentPlan: ReplenishmentPlan;
      requiresSignerAuthorization: true;
      ownerApprovalRequired: false;
    }
  | {
      eligible: false;
      action: "reject";
      code: string;
      message: string;
      requiresSignerAuthorization: false;
      ownerApprovalRequired: false;
    };

function reject(code: string, message: string): PaymentPolicyDecision {
  return { eligible: false, action: "reject", code, message, requiresSignerAuthorization: false, ownerApprovalRequired: false };
}

function parseAtoms(value: string, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new Error(field + "_must_be_integer_atoms");
  }
  return BigInt(value);
}

function spendableAtoms(wallet: PolicyWalletSnapshot): bigint {
  const confirmed = parseAtoms(wallet.confirmedAtoms, "confirmed_atoms");
  const reserved = parseAtoms(wallet.reservedAtoms, "reserved_atoms");
  if (reserved > confirmed) throw new Error("reserved_atoms_exceed_confirmed_atoms");
  return confirmed - reserved;
}

function isFresh(observedAt: string, nowMs: number, maxAgeSeconds: number): boolean {
  const observedMs = Date.parse(observedAt);
  return Number.isFinite(observedMs) &&
    observedMs <= nowMs + 30_000 &&
    nowMs - observedMs <= maxAgeSeconds * 1000;
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/**
 * Evaluates whether a payment intent satisfies deterministic business policy.
 *
 * This function only evaluates and plans. It never reserves balances, creates
 * transactions, signs, broadcasts, or grants execution authority.
 */
export function evaluatePaymentIntentPolicy(
  intent: PaymentIntent,
  policy: PaymentPolicy,
  wallets: PolicyWalletSnapshot[],
  nowMs = Date.now()
): PaymentPolicyDecision {
  if (!intent || !policy || !Array.isArray(wallets)) return reject("invalid_input", "A payment intent, policy and wallet snapshots are required.");
  if (!intent.operationId || intent.operationId.length > 128 ||
      !intent.idempotencyKey || intent.idempotencyKey.length < 8 || intent.idempotencyKey.length > 128) {
    return reject("invalid_operation_identity", "A bounded operation ID and idempotency key are required.");
  }
  if (!intent.businessId || intent.businessId !== policy.businessId) {
    return reject("business_scope_mismatch", "The payment intent does not belong to the policy business.");
  }
  if (!intent.destination || !policy.allowedDestinations.includes(intent.destination)) {
    return reject("destination_not_allowed", "The payment destination is not on the business allowlist.");
  }
  if (!intent.mint || !policy.allowedMints.includes(intent.mint)) {
    return reject("mint_not_allowed", "The payment mint is not on the business asset allowlist.");
  }
  if (typeof intent.allowPartialPayment !== "boolean" ||
      typeof policy.allowPartialPayment !== "boolean" ||
      typeof policy.allowConversion !== "boolean") {
    return reject("invalid_policy_flags", "Partial-payment and conversion permissions must be explicit booleans.");
  }
  let requestedAtoms: bigint;
  let maxTransactionAtoms: bigint;
  let maxDailyAtoms: bigint;
  let committedTodayAtoms: bigint;
  let maxNetworkFeeLamports: bigint;
  let networkFeeLamports: bigint;
  try {
    requestedAtoms = parseAtoms(intent.amountAtoms, "amount_atoms");
    maxTransactionAtoms = parseAtoms(policy.maxTransactionAtoms, "max_transaction_atoms");
    maxDailyAtoms = parseAtoms(policy.maxDailyAtoms, "max_daily_atoms");
    committedTodayAtoms = parseAtoms(policy.committedTodayAtoms, "committed_today_atoms");
    maxNetworkFeeLamports = parseAtoms(policy.maxNetworkFeeLamports, "max_network_fee_lamports");
    networkFeeLamports = parseAtoms(intent.networkFeeLamports, "network_fee_lamports");
  } catch (error) {
    return reject("invalid_amount_policy", error instanceof Error ? error.message : String(error));
  }
  if (requestedAtoms <= 0n || maxTransactionAtoms <= 0n || maxDailyAtoms <= 0n) {
    return reject("invalid_amount_policy", "Payment and configured limits must be greater than zero.");
  }
  if (requestedAtoms > maxTransactionAtoms) {
    return reject("per_transaction_limit_exceeded", "The requested amount exceeds the business per-transaction limit.");
  }

  const createdMs = Date.parse(intent.createdAt);
  const expiresMs = Date.parse(intent.expiresAt);
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs) ||
      createdMs > nowMs + 30_000 || expiresMs <= nowMs ||
      expiresMs <= createdMs || !Number.isSafeInteger(policy.maxIntentLifetimeSeconds) ||
      policy.maxIntentLifetimeSeconds < 1 ||
      expiresMs - createdMs > policy.maxIntentLifetimeSeconds * 1000) {
    return reject("intent_expired_or_invalid", "The payment intent is expired or outside its allowed lifetime.");
  }
  if (!Number.isSafeInteger(policy.maxBalanceAgeSeconds) || policy.maxBalanceAgeSeconds < 1 ||
      policy.maxBalanceAgeSeconds > 86_400) {
    return reject("invalid_balance_freshness_policy", "The configured balance freshness window is invalid.");
  }
  if (!Number.isSafeInteger(policy.maxSlippageBps) || policy.maxSlippageBps < 0 || policy.maxSlippageBps > 10_000) {
    return reject("invalid_slippage_policy", "The configured maximum slippage is invalid.");
  }
  if (intent.slippageBps !== undefined && intent.slippageBps !== null &&
      (!Number.isSafeInteger(intent.slippageBps) || intent.slippageBps < 0 ||
       intent.slippageBps > policy.maxSlippageBps)) {
    return reject("slippage_limit_exceeded", "The requested slippage exceeds the business policy.");
  }
  if (networkFeeLamports > maxNetworkFeeLamports) return reject("network_fee_limit_exceeded", "The estimated network fee exceeds the business policy.");

  const dailyRemaining = maxDailyAtoms > committedTodayAtoms ? maxDailyAtoms - committedTodayAtoms : 0n;
  if (dailyRemaining <= 0n) return reject("daily_limit_exceeded", "The business daily payment limit has been reached.");
  if (requestedAtoms > dailyRemaining && !(intent.allowPartialPayment && policy.allowPartialPayment)) {
    return reject("daily_limit_exceeded", "The requested amount exceeds the remaining daily payment limit.");
  }
  const policyAmountAtoms = minBigInt(requestedAtoms, dailyRemaining);
  const paymentWallets = wallets.filter(wallet =>
    wallet.businessId === policy.businessId && wallet.scope === "business" &&
    wallet.status === "active" && wallet.role === "payment" && wallet.enabled &&
    wallet.mint === intent.mint
  );
  if (paymentWallets.length !== 1) {
    return reject("payment_wallet_configuration_invalid", "Exactly one active business payment wallet must be assigned.");
  }
  const paymentWallet = paymentWallets[0];
  if (!intent.networkFeePayerWalletId ||
      !Array.isArray(policy.allowedFeePayerWalletIds) ||
      !policy.allowedFeePayerWalletIds.includes(intent.networkFeePayerWalletId)) {
    return reject("network_fee_payer_not_allowed", "The network fee payer is not on the business allowlist.");
  }
  const feePayerWallet = wallets.find(wallet =>
    wallet.walletId === intent.networkFeePayerWalletId &&
    wallet.businessId === policy.businessId && wallet.scope === "business" &&
    wallet.status === "active" && wallet.enabled &&
    (wallet.role === "payment" || wallet.role === "operating") &&
    wallet.ownershipVerifiedAt && wallet.mint === "SOL" &&
    isFresh(wallet.observedAt, nowMs, policy.maxBalanceAgeSeconds)
  );
  if (!feePayerWallet) return reject("network_fee_wallet_unavailable", "The approved network fee wallet is missing, unverified, inactive or stale.");
  try {
    if (spendableAtoms(feePayerWallet) < networkFeeLamports) {
      return reject("network_fee_balance_insufficient", "The approved network fee wallet does not have enough spendable SOL.");
    }
  } catch (error) {
    return reject("network_fee_balance_invalid", error instanceof Error ? error.message : String(error));
  }
  if (!paymentWallet.ownershipVerifiedAt) {
    return reject("payment_wallet_unverified", "The designated payment wallet has not proved address control.");
  }
  if (paymentWallet.mint !== intent.mint) {
    return reject("payment_wallet_asset_mismatch", "The designated payment wallet snapshot does not match the requested mint.");
  }
  if (!isFresh(paymentWallet.observedAt, nowMs, policy.maxBalanceAgeSeconds)) {
    return reject("payment_balance_stale", "The payment wallet balance is too old to authorize a payment.");
  }

  let paymentAvailable: bigint;
  try {
    paymentAvailable = spendableAtoms(paymentWallet);
  } catch (error) {
    return reject("payment_balance_invalid", error instanceof Error ? error.message : String(error));
  }

  const sourceSnapshots = wallets.filter(wallet =>
    wallet.businessId === policy.businessId && wallet.scope === "business" &&
    wallet.status === "active" && wallet.enabled &&
    (wallet.role === "reserve" || wallet.role === "operating") &&
    wallet.ownershipVerifiedAt && wallet.mint === intent.mint &&
    isFresh(wallet.observedAt, nowMs, policy.maxBalanceAgeSeconds)
  );
  const sourceByWalletId = new Map<string, PolicyWalletSnapshot>();
  for (const wallet of sourceSnapshots) {
    const existing = sourceByWalletId.get(wallet.walletId);
    // If a wallet has both operating and reserve roles, reserve is the
    // stricter classification and its reserve floor must be preserved.
    if (!existing || wallet.role === "reserve") sourceByWalletId.set(wallet.walletId, wallet);
  }
  const sources: ReplenishmentSource[] = [];
  for (const wallet of sourceByWalletId.values()) {
    try {
      sources.push({
        walletId: wallet.walletId,
        availableAtoms: spendableAtoms(wallet),
        minimumRemainingAtoms: wallet.role === "reserve"
          ? parseAtoms(wallet.minimumRemainingAtoms ?? "0", "minimum_remaining_atoms")
          : 0n,
        maximumTransferAtoms: wallet.maximumTransferAtoms
          ? parseAtoms(wallet.maximumTransferAtoms, "maximum_transfer_atoms")
          : undefined,
        eligible: true
      });
    } catch {
      // An invalid or inconsistent reserve snapshot is excluded rather than
      // being treated as available liquidity.
    }
  }

  let replenishmentPlan: ReplenishmentPlan;
  try {
    replenishmentPlan = planUsdcReplenishment(
      paymentWallet.walletId,
      policyAmountAtoms,
      paymentAvailable,
      sources
    );
  } catch (error) {
    return reject("replenishment_plan_invalid", error instanceof Error ? error.message : String(error));
  }

  if (replenishmentPlan.status === "covered") {
    if (policyAmountAtoms < requestedAtoms) {
      return {
        eligible: true,
        action: "partial_payment",
        paymentWalletId: paymentWallet.walletId,
        requestedAtoms,
        paymentAmountAtoms: policyAmountAtoms,
        unpaidAtoms: requestedAtoms - policyAmountAtoms,
        paymentWalletAvailableAtoms: paymentAvailable,
        replenishmentPlan,
        requiresSignerAuthorization: true,
        ownerApprovalRequired: false
      };
    }
    return {
      eligible: true,
      action: replenishmentPlan.shortfallAtoms === 0n ? "direct_payment" : "replenish_then_pay",
      paymentWalletId: paymentWallet.walletId,
      feePayerWalletId: feePayerWallet.walletId,
      paymentAmountAtoms: policyAmountAtoms,
      paymentWalletAvailableAtoms: paymentAvailable,
      replenishmentPlan,
      requiresSignerAuthorization: true,
      ownerApprovalRequired: false
    };
  }

  if (policy.allowConversion) {
    if (!Array.isArray(policy.allowedConversionMints)) return reject("invalid_conversion_allowlist", "An explicit conversion-source mint allowlist is required.");
    if (intent.slippageBps === undefined || intent.slippageBps === null) {
      return reject("conversion_slippage_required", "A business-approved slippage limit is required before conversion can be considered.");
    }
    const conversionByWallet = new Map<string, { walletId: string; mint: string; availableAtoms: bigint }>();
    for (const source of wallets) {
      if (source.businessId !== policy.businessId || source.scope !== "business" ||
          source.status !== "active" || !source.enabled ||
          (source.role !== "reserve" && source.role !== "operating") ||
          !source.ownershipVerifiedAt || source.mint === intent.mint ||
          !policy.allowedConversionMints.includes(source.mint) ||
          !isFresh(source.observedAt, nowMs, policy.maxBalanceAgeSeconds)) continue;
      try {
        const spendable = spendableAtoms(source);
        const floor = source.role === "reserve"
          ? parseAtoms(source.minimumRemainingAtoms ?? "0", "minimum_remaining_atoms")
          : 0n;
        const aboveFloor = spendable > floor ? spendable - floor : 0n;
        const cap = source.maximumTransferAtoms
          ? parseAtoms(source.maximumTransferAtoms, "maximum_transfer_atoms")
          : aboveFloor;
        const availableAtoms = minBigInt(aboveFloor, cap);
        if (availableAtoms > 0n) {
          const conversionKey = source.walletId + ":" + source.mint;
          const previous = conversionByWallet.get(conversionKey);
          if (!previous || source.role === "reserve") conversionByWallet.set(conversionKey, {
            walletId: source.walletId, mint: source.mint, availableAtoms
          });
        }
      } catch {
        // Invalid or inconsistent conversion sources are never authorised.
      }
    }
    const conversionSourceWallets = [...conversionByWallet.values()].sort((a, b) =>
      a.walletId.localeCompare(b.walletId) || a.mint.localeCompare(b.mint)
    );
    if (conversionSourceWallets.length === 0) {
      return reject("no_authorized_conversion_source", "No fresh, verified reserve or operating wallet holds an explicitly approved conversion asset.");
    }
    return {
      eligible: true,
      action: "conversion_required",
      paymentWalletId: paymentWallet.walletId,
      feePayerWalletId: feePayerWallet.walletId,
      requestedAtoms,
      policyPermittedAtoms: policyAmountAtoms,
      unpaidByPolicyAtoms: requestedAtoms - policyAmountAtoms,
      paymentWalletAvailableAtoms: paymentAvailable,
      replenishmentPlan,
      conversionShortfallAtoms: replenishmentPlan.shortfallAtoms - replenishmentPlan.totalPlannedAtoms,
      conversionSourceWallets,
      requiresSignerAuthorization: true,
      ownerApprovalRequired: true
    };
  }

  if (intent.allowPartialPayment && policy.allowPartialPayment) {
    const availableForPartial = paymentAvailable + replenishmentPlan.totalPlannedAtoms;
    const partialAtoms = minBigInt(policyAmountAtoms, availableForPartial);
    if (partialAtoms > 0n) {
      const partialPlan = planUsdcReplenishment(paymentWallet.walletId, partialAtoms, paymentAvailable, sources);
      return {
        eligible: true,
        action: "partial_payment",
        paymentWalletId: paymentWallet.walletId,
        feePayerWalletId: feePayerWallet.walletId,
        requestedAtoms,
        paymentAmountAtoms: partialAtoms,
        unpaidAtoms: requestedAtoms - partialAtoms,
        paymentWalletAvailableAtoms: paymentAvailable,
        replenishmentPlan: partialPlan,
        requiresSignerAuthorization: true,
        ownerApprovalRequired: false
      };
    }
  }

  return reject("insufficient_authorized_usdc", "The payment wallet and verified reserve wallets cannot cover the requested amount under current policy.");
}
