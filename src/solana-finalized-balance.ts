type RpcEnvelope<T> = { result?: T; error?: { message?: string } };

async function finalizedRpc<T>(
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

export async function fetchFinalizedSplTokenBalance(
  endpoint: string,
  ownerAddress: string,
  mintAddress: string,
  expectedDecimals: number,
  fetcher: typeof fetch = fetch
): Promise<{ amountAtoms: string; commitment: "finalized" }> {
  if (!/^https:\/\//i.test(endpoint)) throw new Error("Solana RPC endpoint must use HTTPS.");
  if (!ownerAddress || !mintAddress || !Number.isSafeInteger(expectedDecimals) ||
      expectedDecimals < 0 || expectedDecimals > 18) {
    throw new Error("Finalized token balance identity is invalid.");
  }
  const result = await finalizedRpc<{
    value?: Array<{
      account?: {
        data?: {
          parsed?: {
            info?: {
              owner?: string;
              mint?: string;
              tokenAmount?: { amount?: string; decimals?: number };
            };
          };
        };
      };
    }>;
  }>(endpoint, "getTokenAccountsByOwner", [
    ownerAddress, { mint: mintAddress }, { encoding: "jsonParsed", commitment: "finalized" }
  ], fetcher);
  if (!Array.isArray(result.value)) throw new Error("Finalized token balance response is malformed.");
  let total = 0n;
  for (const account of result.value) {
    const info = account.account?.data?.parsed?.info;
    const amount = info?.tokenAmount?.amount;
    if (info?.owner !== ownerAddress || info.mint !== mintAddress ||
        info.tokenAmount?.decimals !== expectedDecimals ||
        typeof amount !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(amount)) {
      throw new Error("Finalized token account identity or amount is invalid.");
    }
    total += BigInt(amount);
    if (total > 9_223_372_036_854_775_807n) {
      throw new Error("Finalized token balance exceeds the supported integer range.");
    }
  }
  return { amountAtoms: total.toString(), commitment: "finalized" };
}
