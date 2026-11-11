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
  // V1 reserves from one wallet atomically. Do not aggregate balances across
  // wallets until split reservations can be committed as one transaction.
  const availableAtoms = eligible
    .filter((balance) => balance.token.toUpperCase() === requestedToken.toUpperCase())
    .reduce((largest, balance) => balance.availableAtoms > largest ? balance.availableAtoms : largest, 0n);

  if (availableAtoms >= requestedAtoms) {
    return { action: "direct_fulfillment", availableAtoms, shortfallAtoms: 0n, eligibleSourceTokens: [] };
  }

  const shortfallAtoms = requestedAtoms - availableAtoms;
  const eligibleSourceTokens = [...new Set(
    eligible.filter((balance) => balance.token.toUpperCase() !== requestedToken.toUpperCase())
      .map((balance) => balance.token.toUpperCase())
  )];

  return {
    action: eligibleSourceTokens.length ? "conversion_required" : "insufficient_authorized_funds",
    availableAtoms,
    shortfallAtoms,
    eligibleSourceTokens
  };
}

export function makeOperationId(): string {
  return `op_${crypto.randomUUID().replaceAll("-", "")}`;
}
