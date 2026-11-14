export type SolanaRpcSignatureStatus = {
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
  confirmations?: number | null;
  err?: unknown | null;
  slot?: number;
};

export type FinalizedTransactionLookup =
  | { state: "pending"; reason: string }
  | { state: "failed"; reason: string; slot?: number }
  | { state: "finalized"; transaction: Record<string, unknown>; slot: number };

type RpcEnvelope<T> = { result?: T; error?: { code?: number; message?: string } };

async function rpc<T>(
  endpoint: string,
  method: string,
  params: unknown[],
  fetcher: typeof fetch
): Promise<T> {
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params })
  });
  if (!response.ok) throw new Error("Solana RPC HTTP " + response.status);
  const payload = await response.json() as RpcEnvelope<T>;
  if (payload.error || payload.result === undefined) {
    throw new Error(payload.error?.message ?? "Solana RPC returned no result for " + method);
  }
  return payload.result;
}

/**
 * Fetches a transaction only after the RPC reports its signature finalized.
 * A client-provided signature is only a lookup key; callers must still verify
 * the transaction contents against the immutable funding-leg record.
 */
export async function fetchFinalizedSolanaTransaction(
  endpoint: string,
  signature: string,
  fetcher: typeof fetch = fetch
): Promise<FinalizedTransactionLookup> {
  if (!/^https:\/\//i.test(endpoint)) throw new Error("Solana RPC endpoint must use HTTPS.");
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(signature)) {
    throw new Error("Transaction signature encoding is invalid.");
  }

  const statuses = await rpc<{ value: Array<SolanaRpcSignatureStatus | null> }>(
    endpoint,
    "getSignatureStatuses",
    [[signature], { searchTransactionHistory: true }],
    fetcher
  );
  const status = statuses.value?.[0];
  if (!status) return { state: "pending", reason: "Transaction signature is not indexed by the RPC yet." };
  if (status.err !== null && status.err !== undefined) {
    return { state: "failed", reason: "Solana reports that the transaction failed.", slot: status.slot };
  }
  if (status.confirmationStatus !== "finalized") {
    return { state: "pending", reason: "Transaction has not reached finalized commitment." };
  }

  const transaction = await rpc<Record<string, unknown> | null>(
    endpoint,
    "getTransaction",
    [signature, {
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0
    }],
    fetcher
  );
  if (!transaction) {
    return { state: "pending", reason: "Finalized transaction data is not available from the RPC yet." };
  }
  const slot = transaction.slot;
  const signatures = (transaction.transaction as { signatures?: unknown } | undefined)?.signatures;
  if (!Number.isSafeInteger(slot) || (slot as number) <= 0 ||
      !Array.isArray(signatures) || !signatures.includes(signature)) {
    return { state: "pending", reason: "RPC transaction response does not yet match the submitted signature and finalized slot." };
  }
  const meta = transaction.meta as { err?: unknown | null } | undefined;
  if (!meta || (meta.err !== null && meta.err !== undefined)) {
    return { state: "failed", reason: "Finalized transaction contains an execution error.", slot: slot as number };
  }
  return { state: "finalized", transaction, slot: slot as number };
}
