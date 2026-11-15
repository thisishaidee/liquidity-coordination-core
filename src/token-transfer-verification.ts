export type SolanaTokenTransferTransaction = {
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
      instructions?: ParsedTokenInstruction[];
    };
  };
  meta?: {
    err?: unknown | null;
    preTokenBalances?: Array<{ accountIndex?: number; owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>;
    postTokenBalances?: Array<{ accountIndex?: number; owner?: string; mint?: string; uiTokenAmount?: { amount?: string } }>;
    innerInstructions?: Array<{ instructions?: ParsedTokenInstruction[] }>;
  };
};

type ParsedTokenInstruction = {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
};

export type TokenTransferVerification = {
  verified: boolean;
  reason: string;
  actualAmountAtoms?: bigint;
};

const TOKEN_PROGRAMS = new Set([
  "spl-token",
  "spl-token-2022",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);

/**
 * Verifies one exact, finalized SPL-token transfer between registered wallet
 * owners. It does not establish finality itself; callers must fetch the
 * transaction at finalized commitment and reject non-finalized signatures.
 */
export function verifyExactSplTokenTransfer(
  transaction: SolanaTokenTransferTransaction,
  expected: {
    sourceOwner: string;
    destinationOwner: string;
    mint: string;
    amountAtoms: bigint;
  }
): TokenTransferVerification {
  const fail = (reason: string): TokenTransferVerification => ({ verified: false, reason });
  const message = transaction.transaction?.message;
  const meta = transaction.meta;
  const keys = message?.accountKeys;
  if (!message || !meta || !Array.isArray(keys) ||
      !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances)) {
    return fail("Finalized transaction is missing token-account ownership metadata.");
  }
  if (meta.err !== null && meta.err !== undefined) return fail("Finalized transaction contains an execution error.");
  if (expected.amountAtoms <= 0n) return fail("Expected token amount must be positive.");

  const pubkeyAt = (index: number): string | undefined => {
    const entry = keys[index];
    return typeof entry === "string" ? entry : entry?.pubkey;
  };
  const signer = keys.some(entry =>
    typeof entry !== "string" && entry?.pubkey === expected.sourceOwner && entry.signer === true
  );
  if (!signer) return fail("Registered source wallet did not sign the finalized transfer.");

  const pre = new Map(meta.preTokenBalances.map(balance => [
    balance.accountIndex,
    { owner: balance.owner, mint: balance.mint }
  ]));
  const post = new Map(meta.postTokenBalances.map(balance => [
    balance.accountIndex,
    { owner: balance.owner, mint: balance.mint }
  ]));

  const instructions = [
    ...(message.instructions ?? []),
    ...(meta.innerInstructions ?? []).flatMap(group => group.instructions ?? [])
  ];
  const outgoing = instructions.filter(instruction => {
    const info = instruction.parsed?.info ?? {};
    return TOKEN_PROGRAMS.has(instruction.program ?? instruction.programId ?? "") &&
      ["transfer", "transferChecked"].includes(instruction.parsed?.type ?? "") &&
      info.authority === expected.sourceOwner;
  });
  if (outgoing.length !== 1) {
    return fail("Transaction must contain exactly one parsed token transfer authorised by the registered source wallet.");
  }

  const instruction = outgoing[0];
  const info = instruction.parsed?.info ?? {};
  const source = info.source;
  const destination = info.destination;
  const authority = info.authority;
  const amountInfo = info.tokenAmount && typeof info.tokenAmount === "object"
    ? (info.tokenAmount as Record<string, unknown>).amount
    : info.amount;
  if (typeof source !== "string" || typeof destination !== "string" ||
      authority !== expected.sourceOwner || typeof amountInfo !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(amountInfo)) {
    return fail("Token transfer instruction is missing canonical source, destination, authority or amount fields.");
  }

  const sourceIndex = keys.findIndex((_, index) => pubkeyAt(index) === source);
  const destinationIndex = keys.findIndex((_, index) => pubkeyAt(index) === destination);
  if (sourceIndex < 0 || destinationIndex < 0) return fail("Token transfer accounts are absent from transaction account keys.");

  const sourcePre = pre.get(sourceIndex);
  const sourcePost = post.get(sourceIndex);
  const destinationPre = pre.get(destinationIndex);
  const destinationPost = post.get(destinationIndex);
  const instructionMint = info.mint;
  const mint = typeof instructionMint === "string" ? instructionMint : sourcePre?.mint;
  const sourcePreBalance = meta.preTokenBalances.find(balance => balance.accountIndex === sourceIndex);
  const sourcePostBalance = meta.postTokenBalances.find(balance => balance.accountIndex === sourceIndex);
  const destinationPreBalance = meta.preTokenBalances.find(balance => balance.accountIndex === destinationIndex);
  const destinationPostBalance = meta.postTokenBalances.find(balance => balance.accountIndex === destinationIndex);
  if (
    sourcePre?.owner !== expected.sourceOwner ||
    sourcePost?.owner !== expected.sourceOwner ||
    sourcePre?.mint !== expected.mint ||
    sourcePost?.mint !== expected.mint ||
    (destinationPre && (destinationPre.owner !== expected.destinationOwner || destinationPre.mint !== expected.mint)) ||
    destinationPost?.owner !== expected.destinationOwner ||
    destinationPost?.mint !== expected.mint ||
    mint !== expected.mint ||
    !sourcePreBalance?.uiTokenAmount?.amount ||
    !sourcePostBalance?.uiTokenAmount?.amount ||
    !destinationPostBalance?.uiTokenAmount?.amount
  ) {
    return fail("Token transfer mint or token-account ownership does not match the registered wallets.");
  }

  const actualAmountAtoms = BigInt(amountInfo);
  const sourceDebit = BigInt(sourcePreBalance.uiTokenAmount.amount) - BigInt(sourcePostBalance.uiTokenAmount.amount);
  const destinationCredit = BigInt(destinationPostBalance.uiTokenAmount.amount) -
    BigInt(destinationPreBalance?.uiTokenAmount?.amount ?? "0");
  if (sourceDebit !== actualAmountAtoms || destinationCredit !== actualAmountAtoms) {
    return fail("Token-account balance deltas do not reconcile exactly to the parsed transfer instruction.");
  }
  if (actualAmountAtoms !== expected.amountAtoms) {
    return {
      verified: false,
      reason: "Finalized token transfer amount does not exactly match the reserved funding leg.",
      actualAmountAtoms
    };
  }
  return {
    verified: true,
    reason: "Finalized SPL-token transfer exactly matches the reserved source, destination, mint and amount.",
    actualAmountAtoms
  };
}
