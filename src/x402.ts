export const HERMES_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type HermesPaymentRequirement = {
  scheme: "exact";
  network: "solana";
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  feePayer: string;
};

export type HermesPaymentPayload = {
  x402Version: 1;
  scheme: "exact";
  network: "solana";
  transaction: string;
};

export type HermesPaymentReceipt = {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
};

function decodeBase64Json(value: string): unknown {
  if (!value || value.length > 200_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid base64 x402 value.");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function parseHermesPaymentRequirement(
  responseBody: string,
  path: string
): HermesPaymentRequirement | null {
  let body: unknown;
  try { body = JSON.parse(responseBody) as unknown; } catch { return null; }
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (record.x402Version !== 1 || !Array.isArray(record.accepts)) return null;
  const resource = `https://hermes.swap.io${path}`;
  const selected = record.accepts.find((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const item = raw as Record<string, unknown>;
    return item.scheme === "exact" && item.network === "solana" && item.asset === HERMES_USDC_MINT;
  }) as Record<string, unknown> | undefined;
  if (!selected) return null;
  const extra = selected.extra && typeof selected.extra === "object"
    ? selected.extra as Record<string, unknown>
    : {};
  const amount = selected.maxAmountRequired;
  const timeout = selected.maxTimeoutSeconds;
  if (
    typeof amount !== "string" || !/^\d{1,18}$/.test(amount) || BigInt(amount) <= 0n ||
    selected.resource !== resource ||
    typeof selected.payTo !== "string" || !BASE58.test(selected.payTo) ||
    typeof extra.feePayer !== "string" || !BASE58.test(extra.feePayer) ||
    typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 120
  ) return null;
  return {
    scheme: "exact",
    network: "solana",
    maxAmountRequired: amount,
    resource,
    payTo: selected.payTo,
    asset: HERMES_USDC_MINT,
    maxTimeoutSeconds: timeout,
    feePayer: extra.feePayer
  };
}

export function parseHermesPaymentPayload(header: string): HermesPaymentPayload | null {
  try {
    const raw = decodeBase64Json(header);
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const payload = value.payload && typeof value.payload === "object"
      ? value.payload as Record<string, unknown>
      : {};
    const transaction = payload.transaction;
    if (
      value.x402Version !== 1 || value.scheme !== "exact" || value.network !== "solana" ||
      typeof transaction !== "string" || transaction.length < 100 || transaction.length > 150_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(transaction)
    ) return null;
    return { x402Version: 1, scheme: "exact", network: "solana", transaction };
  } catch {
    return null;
  }
}

export function parseHermesPaymentReceipt(header: string): HermesPaymentReceipt | null {
  try {
    const raw = decodeBase64Json(header);
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    if (
      value.success !== true ||
      typeof value.transaction !== "string" ||
      !BASE58.test(value.transaction) ||
      (value.network !== "solana" && value.network !== "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") ||
      (value.payer !== undefined && (typeof value.payer !== "string" || !BASE58.test(value.payer)))
    ) return null;
    return {
      success: true,
      transaction: value.transaction,
      network: value.network,
      ...(typeof value.payer === "string" ? { payer: value.payer } : {})
    };
  } catch {
    return null;
  }
}


export type HermesPaymentTransaction = {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
      instructions?: Array<{
        program?: string;
        parsed?: { type?: string; info?: Record<string, unknown> };
      }>;
    };
  };
  meta?: {
    err?: unknown | null;
    preTokenBalances?: Array<{ accountIndex?: number; owner?: string; mint?: string }>;
    postTokenBalances?: Array<{ accountIndex?: number; owner?: string; mint?: string }>;
  };
};

export function verifyHermesPaymentTransaction(
  transaction: HermesPaymentTransaction,
  requirement: HermesPaymentRequirement,
  payerAddress: string
): { verified: boolean; reason: string } {
  const fail = (reason: string) => ({ verified: false, reason });
  const keys = transaction.transaction?.message?.accountKeys;
  const instructions = transaction.transaction?.message?.instructions;
  const meta = transaction.meta;
  if (!keys || !instructions || !meta || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
    return fail("Settled x402 transaction is missing parsed account or token-balance metadata.");
  }
  if (meta.err) return fail("Settled x402 transaction contains an execution error.");
  const keyAddress = (entry: string | { pubkey?: string }) => typeof entry === "string" ? entry : entry.pubkey;
  const payer = keys.find((entry) => keyAddress(entry) === payerAddress);
  const feePayer = keys[0];
  if (!payer || typeof payer === "string" || payer.signer !== true) {
    return fail("Dedicated x402 payment wallet did not sign the settlement transaction.");
  }
  if (!feePayer || typeof feePayer === "string" || keyAddress(feePayer) !== requirement.feePayer || feePayer.signer !== true) {
    return fail("Hermes settlement did not use the fee payer advertised by the payment challenge.");
  }
  const preOwners = new Map(meta.preTokenBalances.map((balance) => [balance.accountIndex, { owner: balance.owner, mint: balance.mint }]));
  const postOwners = new Map(meta.postTokenBalances.map((balance) => [balance.accountIndex, { owner: balance.owner, mint: balance.mint }]));
  const accountIndex = new Map(keys.map((entry, index) => [keyAddress(entry), index]));
  const amount = requirement.maxAmountRequired;
  const matches = instructions.filter((instruction) => {
    if (instruction.program !== "spl-token" && instruction.program !== "spl-token-2022") return false;
    if (instruction.parsed?.type !== "transferChecked") return false;
    const info = instruction.parsed.info ?? {};
    const source = info.source;
    const destination = info.destination;
    const authority = info.authority;
    const mint = info.mint;
    const tokenAmount = info.tokenAmount as { amount?: unknown } | undefined;
    const sourceIndex = typeof source === "string" ? accountIndex.get(source) : undefined;
    const destinationIndex = typeof destination === "string" ? accountIndex.get(destination) : undefined;
    return authority === payerAddress &&
      mint === requirement.asset &&
      tokenAmount?.amount === amount &&
      sourceIndex !== undefined &&
      destinationIndex !== undefined &&
      preOwners.get(sourceIndex)?.owner === payerAddress &&
      preOwners.get(sourceIndex)?.mint === requirement.asset &&
      postOwners.get(destinationIndex)?.owner === requirement.payTo &&
      postOwners.get(destinationIndex)?.mint === requirement.asset;
  });
  if (matches.length !== 1) {
    return fail("Settlement transaction does not contain exactly one authorized USDC TransferChecked for the challenged amount and recipient.");
  }
  return { verified: true, reason: "Settlement transaction matches the challenged USDC amount, recipient, payer and facilitator fee payer." };
}
