export type SolanaSettlementTransaction = {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string; signer?: boolean; writable?: boolean }>;
      instructions?: ParsedInstruction[];
    };
  };
  meta?: {
    err?: unknown | null;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: Array<{ accountIndex?: number; owner?: string; mint?: string }>;
    postTokenBalances?: Array<{ accountIndex?: number; owner?: string; mint?: string }>;
    innerInstructions?: Array<{ instructions?: ParsedInstruction[] }>;
  };
};

type ParsedInstruction = {
  program?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
};

export type SolDebitVerification = {
  verified: boolean;
  reason: string;
  actualDebitAtoms?: bigint;
  expectedDebitAtoms?: bigint;
  rentAtoms?: bigint;
  networkFeeAtoms?: bigint;
};

const TOKEN_PROGRAM_IDS = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const SETTLEMENT_MINTS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
]);

/**
 * Reconciles the registered SOL wallet's finalized native balance delta.
 * Only rent for newly-created, still-open USDC/WSOL token accounts owned by
 * the registered wallet is excluded from the quoted swap input.
 */
export function verifySolSourceDebit(
  transaction: SolanaSettlementTransaction,
  walletAddress: string,
  sourceAmountAtoms: bigint
): SolDebitVerification {
  const fail = (reason: string): SolDebitVerification => ({ verified: false, reason });
  const message = transaction.transaction?.message;
  const meta = transaction.meta;
  const keys = message?.accountKeys;
  const pre = meta?.preBalances;
  const post = meta?.postBalances;
  if (!message || !meta || !Array.isArray(keys) || !Array.isArray(pre) || !Array.isArray(post) ||
      pre.length !== keys.length || post.length !== keys.length || typeof meta.fee !== "number" ||
      !Number.isSafeInteger(meta.fee) || meta.fee < 0) {
    return fail("Finalized transaction is missing complete native-balance metadata.");
  }
  if (meta.err) return fail("Finalized transaction contains an execution error.");
  const walletIndex = keys.findIndex((entry) =>
    (typeof entry === "string" ? entry : entry.pubkey) === walletAddress
  );
  if (walletIndex < 0) return fail("Registered operating wallet is absent from transaction account keys.");
  const walletKey = keys[walletIndex];
  if (typeof walletKey === "string" || walletKey.signer !== true) {
    return fail("Registered operating wallet did not sign the finalized transaction.");
  }
  const feePayer = keys[0];
  const feePaidByWallet = (typeof feePayer === "string" ? feePayer : feePayer.pubkey) === walletAddress;
  const actualDebitAtoms = BigInt(pre[walletIndex]) - BigInt(post[walletIndex]);
  if (actualDebitAtoms <= 0n) return fail("Registered operating wallet has no positive SOL debit.");

  const postTokenBalances = meta.postTokenBalances ?? [];
  const newlyCreatedOwnedTokenAccounts = new Map<number, string>();
  for (const balance of postTokenBalances) {
    if (
      Number.isInteger(balance.accountIndex) &&
      balance.owner === walletAddress &&
      typeof balance.mint === "string" &&
      SETTLEMENT_MINTS.has(balance.mint) &&
      pre[balance.accountIndex!] === 0 &&
      post[balance.accountIndex!] > 0
    ) {
      newlyCreatedOwnedTokenAccounts.set(balance.accountIndex!, keys[balance.accountIndex!] as string);
    }
  }

  const instructions = [
    ...(message.instructions ?? []),
    ...(meta.innerInstructions ?? []).flatMap((group) => group.instructions ?? [])
  ];
  let rentAtoms = 0n;
  const countedAccounts = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.program !== "system" || instruction.parsed?.type !== "createAccount") continue;
    const info = instruction.parsed.info ?? {};
    const source = info.source;
    const destination = info.newAccount;
    const lamports = info.lamports;
    const space = info.space;
    const owner = info.owner;
    if (
      source !== walletAddress ||
      typeof destination !== "string" ||
      typeof lamports !== "number" || !Number.isSafeInteger(lamports) || lamports <= 0 ||
      space !== 165 ||
      typeof owner !== "string" || !TOKEN_PROGRAM_IDS.has(owner) ||
      countedAccounts.has(destination)
    ) continue;
    const matchingAccountIndex = [...newlyCreatedOwnedTokenAccounts.entries()]
      .find(([index, pubkey]) => pubkey === destination && pre[index] === 0 && post[index] > 0);
    if (!matchingAccountIndex) continue;
    countedAccounts.add(destination);
    rentAtoms += BigInt(lamports);
  }

  const networkFeeAtoms = feePaidByWallet ? BigInt(meta.fee) : 0n;
  const expectedDebitAtoms = sourceAmountAtoms + rentAtoms + networkFeeAtoms;
  if (sourceAmountAtoms <= 0n || actualDebitAtoms !== expectedDebitAtoms) {
    return {
      verified: false,
      reason: actualDebitAtoms > expectedDebitAtoms
        ? "Registered wallet SOL debit exceeds the quoted input plus evidenced network fee and token-account rent."
        : "Registered wallet SOL debit does not reconcile to the quoted input plus evidenced network fee and token-account rent.",
      actualDebitAtoms,
      expectedDebitAtoms,
      rentAtoms,
      networkFeeAtoms
    };
  }
  return {
    verified: true,
    reason: "Registered wallet SOL debit exactly matches the quoted input plus evidenced network fee and token-account rent.",
    actualDebitAtoms,
    expectedDebitAtoms,
    rentAtoms,
    networkFeeAtoms
  };
}
