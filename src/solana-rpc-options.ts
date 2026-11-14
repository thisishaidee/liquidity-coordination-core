/**
 * Transaction metadata readers must opt into the newest supported Solana
 * transaction version. v1 is active; setting 1 still accepts legacy and v0.
 */
export const FINALIZED_TRANSACTION_READ_OPTIONS = {
  commitment: "finalized",
  encoding: "jsonParsed",
  maxSupportedTransactionVersion: 1
} as const;
