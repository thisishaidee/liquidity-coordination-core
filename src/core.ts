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


export type ReplenishmentSource = {
  walletId: string;
  availableAtoms: bigint;
  minimumRemainingAtoms?: bigint;
  maximumTransferAtoms?: bigint;
  eligible: boolean;
};

export type ReplenishmentLeg = {
  sourceWalletId: string;
  amountAtoms: bigint;
};

export type ReplenishmentPlan = {
  status: "covered" | "insufficient_authorized_usdc";
  paymentWalletId: string;
  requestedAtoms: bigint;
  paymentWalletAvailableAtoms: bigint;
  shortfallAtoms: bigint;
  totalPlannedAtoms: bigint;
  legs: ReplenishmentLeg[];
};

/**
 * Plans USDC transfers into a designated payment wallet.
 *
 * This is deliberately a pure planning function: it does not reserve balances,
 * create transactions, sign, broadcast, or imply that funds have moved.
 * Callers must pass fresh spendable balances after existing reservations.
 */
export function planUsdcReplenishment(
  paymentWalletId: string,
  requestedAtoms: bigint,
  paymentWalletAvailableAtoms: bigint,
  sources: ReplenishmentSource[]
): ReplenishmentPlan {
  if (!paymentWalletId.trim()) throw new Error("payment wallet is required");
  if (requestedAtoms <= 0n) throw new Error("requested amount must be greater than zero");
  if (paymentWalletAvailableAtoms < 0n) throw new Error("payment wallet balance cannot be negative");

  const shortfallAtoms = requestedAtoms > paymentWalletAvailableAtoms
    ? requestedAtoms - paymentWalletAvailableAtoms
    : 0n;
  if (shortfallAtoms === 0n) {
    return {
      status: "covered",
      paymentWalletId,
      requestedAtoms,
      paymentWalletAvailableAtoms,
      shortfallAtoms: 0n,
      totalPlannedAtoms: 0n,
      legs: []
    };
  }

  const candidates = sources
    .filter((source) => source.eligible && source.walletId !== paymentWalletId)
    .map((source) => {
      const floor = source.minimumRemainingAtoms ?? 0n;
      if (source.availableAtoms < 0n || floor < 0n ||
          (source.maximumTransferAtoms !== undefined && source.maximumTransferAtoms < 0n)) {
        throw new Error("source wallet limits cannot be negative");
      }
      const aboveFloor = source.availableAtoms > floor ? source.availableAtoms - floor : 0n;
      const capped = source.maximumTransferAtoms === undefined || source.maximumTransferAtoms > aboveFloor
        ? aboveFloor
        : source.maximumTransferAtoms;
      return { walletId: source.walletId, capacityAtoms: capped };
    })
    .filter((source) => source.capacityAtoms > 0n);

  // Prefer the smallest single source that covers the shortfall. If no single
  // source can cover it, use largest available capacities first to minimise
  // the number of transfer legs. Wallet ID is a stable tie-breaker.
  const singleSource = candidates
    .filter((source) => source.capacityAtoms >= shortfallAtoms)
    .sort((a, b) => a.capacityAtoms < b.capacityAtoms ? -1 :
      a.capacityAtoms > b.capacityAtoms ? 1 : a.walletId.localeCompare(b.walletId))[0];

  const ordered = singleSource
    ? [singleSource]
    : [...candidates].sort((a, b) => a.capacityAtoms > b.capacityAtoms ? -1 :
      a.capacityAtoms < b.capacityAtoms ? 1 : a.walletId.localeCompare(b.walletId));

  let remaining = shortfallAtoms;
  const legs: ReplenishmentLeg[] = [];
  for (const source of ordered) {
    if (remaining <= 0n) break;
    const amountAtoms = source.capacityAtoms < remaining ? source.capacityAtoms : remaining;
    legs.push({ sourceWalletId: source.walletId, amountAtoms });
    remaining -= amountAtoms;
  }

  const totalPlannedAtoms = legs.reduce((sum, leg) => sum + leg.amountAtoms, 0n);
  return {
    status: remaining === 0n ? "covered" : "insufficient_authorized_usdc",
    paymentWalletId,
    requestedAtoms,
    paymentWalletAvailableAtoms,
    shortfallAtoms,
    totalPlannedAtoms,
    legs
  };
}

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
