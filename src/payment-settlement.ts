export type SolanaPaymentAccountKey = string | {
  pubkey?: string;
  signer?: boolean;
  writable?: boolean;
};

export type SolanaPaymentTokenBalance = {
  accountIndex?: number;
  owner?: string;
  mint?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
  };
};

export type SolanaPaymentInstruction = {
  program?: string;
  programId?: string;
  parsed?: {
    type?: string;
    info?: Record<string, unknown>;
  };
};

export type SolanaPaymentTransaction = {
  slot?: number;
  transaction?: {
    signatures?: string[];
    message?: {
      accountKeys?: SolanaPaymentAccountKey[];
      instructions?: SolanaPaymentInstruction[];
    };
  };
  meta?: {
    err?: unknown | null;
    preTokenBalances?: SolanaPaymentTokenBalance[];
    postTokenBalances?: SolanaPaymentTokenBalance[];
    innerInstructions?: Array<{ instructions?: SolanaPaymentInstruction[] }>;
  };
};

export type ExpectedSolanaTokenTransfer = {
  signature: string;
  sourceWalletAddress: string;
  destinationOwnerAddress: string;
  mint: string;
  amountAtoms: string;
  decimals: number;
};

export type SolanaTokenTransferVerification = {
  verified: boolean;
  reason: string;
  amountAtoms?: string;
  sourceTokenAccount?: string;
  destinationTokenAccount?: string;
  slot?: number;
};

const TOKEN_PROGRAMS = new Set([
  "spl-token",
  "spl-token-2022",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
]);
const ASSOCIATED_TOKEN_PROGRAMS = new Set([
  "spl-associated-token-account",
  "associated-token",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
]);
const COMPUTE_BUDGET_PROGRAMS = new Set([
  "compute-budget",
  "ComputeBudget111111111111111111111111111111"
]);
const SYSTEM_PROGRAMS = new Set(["system", "11111111111111111111111111111111"]);

function programName(instruction: SolanaPaymentInstruction): string {
  return instruction.program || instruction.programId || "";
}

function accountAddress(key: SolanaPaymentAccountKey): string {
  return typeof key === "string" ? key : key.pubkey || "";
}

function amountFromBalance(
  balances: SolanaPaymentTokenBalance[],
  accountIndex: number,
  owner: string,
  mint: string,
  decimals: number
): bigint | null {
  const row = balances.find(item =>
    item.accountIndex === accountIndex &&
    item.owner === owner &&
    item.mint === mint
  );
  if (!row || row.uiTokenAmount?.decimals !== decimals ||
      typeof row.uiTokenAmount.amount !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(row.uiTokenAmount.amount)) return null;
  return BigInt(row.uiTokenAmount.amount);
}

/**
 * Verifies one exact finalized SPL-token transfer against the expected funding
 * leg. It deliberately rejects transactions containing additional value-moving
 * or unrecognized top-level instructions.
 */
export function verifySolanaTokenTransfer(
  transaction: SolanaPaymentTransaction,
  expected: ExpectedSolanaTokenTransfer
): SolanaTokenTransferVerification {
  const fail = (reason: string): SolanaTokenTransferVerification => ({ verified: false, reason });
  if (!transaction || !expected ||
      typeof expected.signature !== "string" || expected.signature.length < 32 ||
      !expected.sourceWalletAddress || !expected.destinationOwnerAddress || !expected.mint ||
      !/^[1-9][0-9]{0,18}$/.test(expected.amountAtoms) ||
      !Number.isSafeInteger(expected.decimals) || expected.decimals < 0 || expected.decimals > 18) {
    return fail("Expected payment-leg identity or amount is invalid.");
  }

  const message = transaction.transaction?.message;
  const meta = transaction.meta;
  const keys = message?.accountKeys;
  if (!message || !meta || !Array.isArray(keys) ||
      !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances) ||
      !Array.isArray(message.instructions) || !Array.isArray(transaction.transaction?.signatures)) {
    return fail("Finalized transaction is missing required message or token-balance metadata.");
  }
  if (meta.err !== null && meta.err !== undefined) return fail("Finalized transaction contains an execution error.");
  if (!Number.isSafeInteger(transaction.slot) || (transaction.slot ?? 0) <= 0) {
    return fail("Finalized transaction slot is missing or invalid.");
  }
  if (!transaction.transaction!.signatures!.includes(expected.signature)) {
    return fail("RPC transaction signatures do not include the submitted signature.");
  }

  const sourceSigner = keys.find(key => accountAddress(key) === expected.sourceWalletAddress);
  if (!sourceSigner || typeof sourceSigner === "string" || sourceSigner.signer !== true) {
    return fail("The registered source wallet did not sign the transaction.");
  }

  const topLevel = message.instructions;
  const inner = (meta.innerInstructions ?? []).flatMap(group => group.instructions ?? []);
  const allInstructions = [...topLevel, ...inner];
  const transferInstructions = allInstructions.filter(instruction => {
    const program = programName(instruction);
    const type = instruction.parsed?.type;
    return TOKEN_PROGRAMS.has(program) && (type === "transfer" || type === "transferChecked");
  });
  if (transferInstructions.length !== 1) {
    return fail("Transaction must contain exactly one SPL-token transfer instruction.");
  }

  for (const instruction of topLevel) {
    const program = programName(instruction);
    const type = instruction.parsed?.type;
    if (TOKEN_PROGRAMS.has(program)) {
      if (type !== "transfer" && type !== "transferChecked") {
        return fail("Transaction contains an additional or unsupported token-program instruction.");
      }
      continue;
    }
    if (COMPUTE_BUDGET_PROGRAMS.has(program)) continue;
    if (ASSOCIATED_TOKEN_PROGRAMS.has(program)) {
      if (type !== "create" && type !== "createIdempotent") {
        return fail("Transaction contains an unsupported associated-token instruction.");
      }
      const info = instruction.parsed?.info ?? {};
      if (info.wallet !== expected.destinationOwnerAddress || info.mint !== expected.mint) {
        return fail("Associated token account creation does not match the approved recipient and mint.");
      }
      continue;
    }
    if (SYSTEM_PROGRAMS.has(program) && type === "createAccount") {
      continue;
    }
    return fail("Transaction contains an unapproved top-level program instruction.");
  }

  const transfer = transferInstructions[0];
  const info = transfer.parsed?.info ?? {};
  const sourceTokenAccount = typeof info.source === "string" ? info.source : "";
  const destinationTokenAccount = typeof info.destination === "string" ? info.destination : "";
  const authority = typeof info.authority === "string" ? info.authority : "";
  const mint = typeof info.mint === "string" ? info.mint : expected.mint;
  const amountText = transfer.parsed?.type === "transferChecked"
    ? (info.tokenAmount as { amount?: unknown } | undefined)?.amount
    : info.amount;
  const decimals = transfer.parsed?.type === "transferChecked"
    ? (info.tokenAmount as { decimals?: unknown } | undefined)?.decimals
    : expected.decimals;

  if (!sourceTokenAccount || !destinationTokenAccount || sourceTokenAccount === destinationTokenAccount ||
      authority !== expected.sourceWalletAddress || mint !== expected.mint ||
      typeof amountText !== "string" || !/^(0|[1-9][0-9]*)$/.test(amountText) ||
      decimals !== expected.decimals || BigInt(amountText) !== BigInt(expected.amountAtoms)) {
    return fail("The SPL-token transfer instruction does not match the approved source, recipient, mint or amount.");
  }

  const sourceIndex = keys.findIndex(key => accountAddress(key) === sourceTokenAccount);
  const destinationIndex = keys.findIndex(key => accountAddress(key) === destinationTokenAccount);
  if (sourceIndex < 0 || destinationIndex < 0) {
    return fail("The source or destination token account is absent from transaction account keys.");
  }

  const beforeSource = amountFromBalance(meta.preTokenBalances, sourceIndex, expected.sourceWalletAddress, expected.mint, expected.decimals);
  const afterSource = amountFromBalance(meta.postTokenBalances, sourceIndex, expected.sourceWalletAddress, expected.mint, expected.decimals);
  const beforeDestination = amountFromBalance(meta.preTokenBalances, destinationIndex, expected.destinationOwnerAddress, expected.mint, expected.decimals) ?? 0n;
  const afterDestination = amountFromBalance(meta.postTokenBalances, destinationIndex, expected.destinationOwnerAddress, expected.mint, expected.decimals);
  if (beforeSource === null || afterSource === null || afterDestination === null) {
    return fail("Token-balance metadata does not prove both token-account owners and mint.");
  }

  const expectedAtoms = BigInt(expected.amountAtoms);
  if (beforeSource - afterSource !== expectedAtoms || afterDestination - beforeDestination !== expectedAtoms) {
    return fail("Observed source debit and recipient credit do not exactly match the approved transfer amount.");
  }

  return {
    verified: true,
    reason: "Finalized transaction proves the exact approved SPL-token transfer.",
    amountAtoms: expectedAtoms.toString(),
    sourceTokenAccount,
    destinationTokenAccount,
    slot: transaction.slot
  };
}
