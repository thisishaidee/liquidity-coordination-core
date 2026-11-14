import { mkdir, writeFile } from "node:fs/promises";

const endpoint = "https://hermes.swap.io/v1/swap/quote";
const outputDir = "artifacts/hermes-402";
const requestBody = {
  input: {
    token: "So11111111111111111111111111111111111111112",
    amount: "1000000000",
    chainKey: "sol"
  },
  output: {
    token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    chainKey: "sol"
  },
  // A public Solana address used only as the quote recipient parameter.
  // No wallet is connected, funded, or asked to sign anything.
  userAddress: "11111111111111111111111111111111",
  slippageBps: 50
};

await mkdir(outputDir, { recursive: true });

const startedAt = new Date().toISOString();
let response;
let responseBody = "";
let networkError = null;

try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(30_000)
  });
  responseBody = await response.text();
} catch (error) {
  networkError = error instanceof Error ? error.message : String(error);
}

const headers = response ? Object.fromEntries(response.headers.entries()) : {};
const rawEvidence = [
  `REQUEST: POST ${endpoint}`,
  `STARTED_AT: ${startedAt}`,
  `REQUEST_BODY: ${JSON.stringify(requestBody, null, 2)}`,
  response
    ? `HTTP_STATUS: ${response.status} ${response.statusText}`
    : `NETWORK_ERROR: ${networkError}`,
  "RESPONSE_HEADERS:",
  JSON.stringify(headers, null, 2),
  "RESPONSE_BODY:",
  responseBody
].join("\n");

await writeFile(`${outputDir}/response.txt`, rawEvidence, "utf8");
await writeFile(`${outputDir}/response.json`, JSON.stringify({
  endpoint,
  startedAt,
  request: requestBody,
  status: response?.status ?? null,
  statusText: response?.statusText ?? null,
  headers,
  body: responseBody,
  networkError
}, null, 2), "utf8");

if (!response) {
  console.error(`Hermes request failed before receiving an HTTP response: ${networkError}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(responseBody);
} catch {
  parsed = null;
}

const solanaUsdc = parsed && Array.isArray(parsed.accepts)
  ? parsed.accepts.find((item) =>
      item &&
      item.scheme === "exact" &&
      item.network === "solana" &&
      item.asset === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    )
  : null;

const checks = {
  http402: response.status === 402,
  validJson: Boolean(parsed && typeof parsed === "object"),
  x402Version1: parsed?.x402Version === 1,
  solanaUsdcExactRequirement: Boolean(solanaUsdc),
  positiveAtomicUsdcAmount: Boolean(
    solanaUsdc &&
    typeof solanaUsdc.maxAmountRequired === "string" &&
    /^[0-9]{1,18}$/.test(solanaUsdc.maxAmountRequired) &&
    BigInt(solanaUsdc.maxAmountRequired) > 0n
  ),
  expectedResource: solanaUsdc?.resource === endpoint,
  validPayTo: typeof solanaUsdc?.payTo === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solanaUsdc.payTo),
  validFeePayer: typeof solanaUsdc?.extra?.feePayer === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(solanaUsdc.extra.feePayer)
};

await writeFile(`${outputDir}/validation.json`, JSON.stringify({
  completedAt: new Date().toISOString(),
  checks,
  selectedSolanaUsdcRequirement: solanaUsdc ?? null
}, null, 2), "utf8");

console.log("Hermes unpaid quote response captured.");
console.log(`HTTP status: ${response.status} ${response.statusText}`);
console.log("Validation:", JSON.stringify(checks, null, 2));
if (Object.values(checks).some((passed) => !passed)) {
  console.error(`Hermes response did not satisfy the expected x402 V1 Solana USDC 402 challenge. Inspect ${outputDir}/response.txt.`);
  process.exit(1);
}
