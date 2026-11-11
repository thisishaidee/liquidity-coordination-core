export type LiquidityBalance = {
  walletId: string;
  token: string;
  availableAtoms: bigint;
  eligible: boolean;
};

export type LiquidityDecision = {
  action: "direct_fulfillment" | "conversion_required" | "insufficient_authorized_funds";
  availableAtoms: bigint;
  shortfallAtoms: bigint;
  eligibleSourceTokens: string[];
  sourceWalletId: string | null;
};

export function parseTokenAmount(value: unknown, decimals = 6): bigint {
  if (typeof value !== "string") throw new Error("amount must be a decimal string");
  const pattern = new RegExp(`^(0|[1-9]\\d*)(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(value)) throw new Error(`amount must be a positive decimal with at most ${decimals} places`);
  const [whole, fraction = ""] = value.split(".");
  const atoms = BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals));
  if (atoms <= 0n) throw new Error("amount must be greater than zero");
  return atoms;
}

export function formatTokenAmount(atoms: bigint, decimals = 6): string {
  const base = 10n ** BigInt(decimals);
  const whole = atoms / base;
  const fraction = (atoms % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function evaluateLiquidity(
  requestedToken: string,
  requestedAtoms: bigint,
  balances: LiquidityBalance[]
): LiquidityDecision {
  const eligible = balances.filter((balance) => balance.eligible && balance.availableAtoms > 0n);
  const target = eligible.filter((balance) => balance.token.toUpperCase() === requestedToken.toUpperCase());
  const largestTarget = target.reduce(
    (best, balance) => balance.availableAtoms > best.availableAtoms ? balance : best,
    { walletId: "", token: requestedToken, availableAtoms: 0n, eligible: true }
  );

  if (largestTarget.availableAtoms >= requestedAtoms) {
    return {
      action: "direct_fulfillment",
      availableAtoms: largestTarget.availableAtoms,
      shortfallAtoms: 0n,
      eligibleSourceTokens: [],
      sourceWalletId: largestTarget.walletId || null
    };
  }

  // A conversion must land in the same wallet whose USDC balance is being
  // counted. Never combine USDC in one wallet with SOL in another.
  const sourceWalletIds = [...new Set(
    eligible.filter((balance) => balance.token.toUpperCase() !== requestedToken.toUpperCase())
      .map((balance) => balance.walletId)
  )];

  const conversionCandidates = sourceWalletIds.map((walletId) => {
    const targetBalance = target.find((balance) => balance.walletId === walletId);
    const sourceTokens = [...new Set(
      eligible.filter((balance) => balance.walletId === walletId &&
        balance.token.toUpperCase() !== requestedToken.toUpperCase())
        .map((balance) => balance.token.toUpperCase())
    )];
    return {
      walletId,
      availableAtoms: targetBalance?.availableAtoms ?? 0n,
      sourceTokens
    };
  }).sort((a, b) => a.availableAtoms > b.availableAtoms ? -1 : a.availableAtoms < b.availableAtoms ? 1 : 0);

  const conversion = conversionCandidates[0];
  if (conversion) {
    return {
      action: "conversion_required",
      availableAtoms: conversion.availableAtoms,
      shortfallAtoms: requestedAtoms - conversion.availableAtoms,
      eligibleSourceTokens: conversion.sourceTokens,
      sourceWalletId: conversion.walletId
    };
  }

  return {
    action: "insufficient_authorized_funds",
    availableAtoms: largestTarget.availableAtoms,
    shortfallAtoms: requestedAtoms - largestTarget.availableAtoms,
    eligibleSourceTokens: [],
    sourceWalletId: null
  };
}

export function makeOperationId(): string {
  return `op_${crypto.randomUUID().replaceAll("-", "")}`;
}
