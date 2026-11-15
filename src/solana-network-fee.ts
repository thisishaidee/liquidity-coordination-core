export type SolanaNetworkFeeTransaction = {
  meta?: { fee?: unknown };
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey?: string; signer?: boolean }>;
    };
  };
};

export type SolanaNetworkFeeVerification =
  | { verified: true; actualFeeLamports: string }
  | { verified: false; reason: string };

/**
 * Verifies the finalized transaction's network fee against the registered
 * business fee payer and the immutable maximum fee hold. This does not prove
 * arbitrary SOL transfers; callers must separately validate the transaction.
 */
export function verifySolanaNetworkFee(
  transaction: SolanaNetworkFeeTransaction,
  expectedFeePayerAddress: string,
  maximumFeeLamports: string
): SolanaNetworkFeeVerification {
  if (!expectedFeePayerAddress ||
      !/^(0|[1-9][0-9]{0,18})$/.test(maximumFeeLamports) ||
      BigInt(maximumFeeLamports) > 9_223_372_036_854_775_807n) {
    return { verified: false, reason: "Approved network-fee identity or cap is invalid." };
  }
  const fee = transaction?.meta?.fee;
  const firstKey = transaction?.transaction?.message?.accountKeys?.[0];
  const feePayerAddress = typeof firstKey === "string" ? firstKey : firstKey?.pubkey;
  const feePayerSigned = typeof firstKey !== "string" && firstKey?.signer === true;
  if (!Number.isSafeInteger(fee) || (fee as number) < 0) {
    return { verified: false, reason: "Finalized transaction does not contain a valid network fee." };
  }
  if (feePayerAddress !== expectedFeePayerAddress || !feePayerSigned) {
    return { verified: false, reason: "Finalized transaction fee payer is not the registered business wallet with a verified transaction signature." };
  }
  const actual = BigInt(fee as number);
  if (actual > BigInt(maximumFeeLamports)) {
    return { verified: false, reason: "Finalized transaction network fee exceeds the approved fee cap." };
  }
  return { verified: true, actualFeeLamports: actual.toString() };
}
