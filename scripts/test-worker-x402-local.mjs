import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = "http://127.0.0.1:8787";
const evidenceDir = "artifacts/worker-x402";
const output = {
  startedAt: new Date().toISOString(),
  environment: "GitHub Actions ephemeral runner; Wrangler local mode; local D1 only",
  safety: {
    cloudflareCredentialsUsed: false,
    productionDatabaseUsed: false,
    paymentHeaderSent: false,
    walletFunded: false,
    transactionSigned: false,
    transactionBroadcast: false
  },
  steps: {},
  errors: []
};

await mkdir(evidenceDir, { recursive: true });

function runWrangler(args, label) {
  const result = spawnSync("npx", ["wrangler", ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }
  });
  const log = [result.stdout ?? "", result.stderr ?? ""].join("\n");
  output.steps[label] = { exitCode: result.status, log: log.slice(-12000) };
  if (result.error || result.status !== 0) {
    throw new Error(label + " failed: " + (result.error?.message ?? log.slice(-2500)));
  }
  return result.stdout ?? "";
}

function parseD1Rows(raw, label) {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Could not parse D1 JSON output for " + label + ": " + raw.slice(-2000));
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false) throw new Error("D1 query failed for " + label + ": " + raw.slice(-2000));
  return first.results ?? [];
}

function queryD1(sql, label) {
  const raw = runWrangler(["d1", "execute", "liquidity-coordination", "--local", "--json", "--command", sql], label);
  return parseD1Rows(raw, label);
}

async function waitForWorker(child, getLogs) {
  const deadline = Date.now() + 60_000;
  let lastError = "Worker has not started";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Wrangler dev exited early: " + getLogs().slice(-3000));
    try {
      const response = await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(2500) });
      if (response.ok) {
        const body = await response.json();
        if (body.service === "nerith-api" && body.database === "connected") return body;
        lastError = "Unexpected health response: " + JSON.stringify(body);
      } else {
        lastError = "Health returned HTTP " + response.status;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Local Worker did not become healthy: " + lastError + "\n" + getLogs().slice(-3000));
}

let worker;
let workerLog = "";
try {
  runWrangler(["d1", "migrations", "apply", "liquidity-coordination", "--local"], "applyLocalD1Migrations");

  worker = spawn("npx", ["wrangler", "dev", "--local", "--port", "8787", "--ip", "127.0.0.1"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }
  });
  worker.stdout.on("data", chunk => { workerLog += chunk.toString(); });
  worker.stderr.on("data", chunk => { workerLog += chunk.toString(); });

  output.steps.localWorkerHealth = await waitForWorker(worker, () => workerLog);

  const suffix = randomBytes(8).toString("hex");
  const businessId = "biz_" + randomBytes(16).toString("hex");
  const agentId = "agt_" + randomBytes(16).toString("hex");
  const operatingWalletId = "wal_" + randomBytes(16).toString("hex");
  const paymentWalletId = "wal_" + randomBytes(16).toString("hex");
  const apiKey = "lci_track2_" + randomBytes(32).toString("hex");
  const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
  const operatingAddress = "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD";
  const paymentAddress = "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4";

  const seedSql = `
    PRAGMA foreign_keys = ON;
    INSERT INTO businesses (id, name) VALUES ('${businessId}', 'NERITH Track Two Test');
    INSERT INTO agents (id, business_id, name, api_key_hash, can_use_business_treasury)
      VALUES ('${agentId}', '${businessId}', 'Track Two Agent', '${apiKeyHash}', 0);
    INSERT INTO wallets (id, business_id, agent_id, network, address, scope, purpose)
      VALUES ('${operatingWalletId}', '${businessId}', '${agentId}', 'solana', '${operatingAddress}', 'agent', 'operating');
    INSERT INTO wallets (id, business_id, agent_id, network, address, scope, purpose)
      VALUES ('${paymentWalletId}', '${businessId}', NULL, 'solana', '${paymentAddress}', 'business', 'api_payment');
    INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
      VALUES ('bal_${randomBytes(16).toString("hex")}', '${operatingWalletId}', 'USDC', '2000000', '0', datetime('now'), 'track2_fixture');
    INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
      VALUES ('bal_${randomBytes(16).toString("hex")}', '${operatingWalletId}', 'SOL', '2000000000', '0', datetime('now'), 'track2_fixture');
    INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
      VALUES ('bal_${randomBytes(16).toString("hex")}', '${paymentWalletId}', 'USDC', '20000', '0', datetime('now'), 'track2_fixture');
  `;
  const seedFile = join(tmpdir(), "nerith-track2-seed-" + suffix + ".sql");
  await writeFile(seedFile, seedSql, "utf8");
  runWrangler(["d1", "execute", "liquidity-coordination", "--local", "--file", seedFile], "seedLocalTestFixtures");

  const authHeaders = {
    authorization: "Bearer " + apiKey,
    "content-type": "application/json"
  };

  const liquidityResponse = await fetch(baseUrl + "/v1/liquidity/requests", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      taskId: "track2-" + suffix,
      network: "solana",
      token: "USDC",
      amount: "10",
      purpose: "Track two controlled conversion shortfall test"
    })
  });
  const liquidityText = await liquidityResponse.text();
  let liquidityBody;
  try { liquidityBody = JSON.parse(liquidityText); } catch { liquidityBody = null; }
  output.steps.liquidityAssessment = {
    status: liquidityResponse.status,
    body: liquidityBody
  };
  if (liquidityResponse.status !== 201 || liquidityBody?.action !== "conversion_required" ||
      liquidityBody?.status !== "awaiting_conversion" || liquidityBody?.liquidity?.shortfall !== "8") {
    throw new Error("Liquidity assessment did not produce the expected 8 USDC conversion shortfall: " + liquidityText);
  }

  const quoteRequest = {
    operationId: liquidityBody.operationId,
    userAddress: operatingAddress,
    paymentWalletAddress: paymentAddress,
    sourceAmount: "1",
    slippageBps: 50
  };
  const quoteResponse = await fetch(baseUrl + "/v1/conversions/quote", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(quoteRequest)
  });
  const quoteBodyText = await quoteResponse.text();
  const quoteHeaders = Object.fromEntries(quoteResponse.headers.entries());
  let quoteBody;
  try { quoteBody = JSON.parse(quoteBodyText); } catch { quoteBody = null; }

  output.steps.workerQuoteRelay = {
    request: quoteRequest,
    status: quoteResponse.status,
    statusText: quoteResponse.statusText,
    headers: quoteHeaders,
    body: quoteBodyText
  };

  if (quoteResponse.status !== 402 || !quoteBody || quoteBody.x402Version !== 1 || !Array.isArray(quoteBody.accepts)) {
    throw new Error("NERITH did not relay a valid Hermes HTTP 402 x402 challenge. HTTP " +
      quoteResponse.status + " body: " + quoteBodyText);
  }

  const requirement = quoteBody.accepts.find(item =>
    item?.scheme === "exact" &&
    item?.network === "solana" &&
    item?.asset === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  );
  if (!requirement) throw new Error("Relayed challenge did not contain the expected exact Solana USDC requirement.");
  if (typeof requirement.maxAmountRequired !== "string" || !/^[0-9]{1,18}$/.test(requirement.maxAmountRequired) ||
      BigInt(requirement.maxAmountRequired) <= 0n) {
    throw new Error("Relayed challenge has an invalid atomic USDC amount.");
  }

  const challengeRows = queryD1(
    "SELECT id, resource, amount_atoms, pay_to, asset, fee_payer, status, expires_at " +
    "FROM x402_payment_challenges WHERE agent_id = '" + agentId + "' ORDER BY created_at DESC LIMIT 5",
    "readPersistedX402Challenge"
  );
  const paymentReservationRows = queryD1(
    "SELECT COUNT(*) AS total FROM x402_payment_reservations",
    "verifyNoPaymentReservations"
  );
  const spendLimitRows = queryD1(
    "SELECT COUNT(*) AS total FROM x402_spend_limits",
    "verifyNoSpendBudgetReservation"
  );
  const operationRows = queryD1(
    "SELECT id, status, action, shortfall_atoms, source_wallet_id FROM operations WHERE id = '" +
    liquidityBody.operationId + "' LIMIT 1",
    "verifyOperationStateInD1"
  );

  const stored = challengeRows[0];
  const databaseChecks = {
    oneChallengeStored: challengeRows.length === 1,
    challengeStatusPending: stored?.status === "pending",
    amountMatchesRelayedChallenge: String(stored?.amount_atoms ?? "") === requirement.maxAmountRequired,
    resourceMatchesRelayedChallenge: stored?.resource === requirement.resource,
    recipientMatchesRelayedChallenge: stored?.pay_to === requirement.payTo,
    assetMatchesRelayedChallenge: stored?.asset === requirement.asset,
    feePayerMatchesRelayedChallenge: stored?.fee_payer === requirement.extra?.feePayer,
    noPaymentReservationCreated: Number(paymentReservationRows[0]?.total) === 0,
    noSpendLimitsCreatedWithoutPayment: Number(spendLimitRows[0]?.total) === 0,
    operationRemainsAwaitingConversion: operationRows[0]?.status === "awaiting_conversion" &&
      operationRows[0]?.action === "conversion_required" &&
      operationRows[0]?.shortfall_atoms === "8000000"
  };
  output.steps.databaseVerification = {
    checks: databaseChecks,
    persistedChallenge: stored ?? null,
    paymentReservations: paymentReservationRows[0] ?? null,
    spendLimits: spendLimitRows[0] ?? null,
    operation: operationRows[0] ?? null
  };

  if (Object.values(databaseChecks).some(value => value !== true)) {
    throw new Error("D1 persistence/safety verification failed: " + JSON.stringify(databaseChecks));
  }

  output.result = "PASS";
  output.completedAt = new Date().toISOString();
  await writeFile(join(evidenceDir, "report.json"), JSON.stringify(output, null, 2), "utf8");
  await writeFile(join(evidenceDir, "http-evidence.txt"), [
    "NERITH LOCAL WORKER -> LIVE HERMES UNPAID 402 TEST",
    "Environment: GitHub Actions runner, Wrangler local mode, local D1 only",
    "POST /v1/liquidity/requests -> " + liquidityResponse.status,
    JSON.stringify(liquidityBody, null, 2),
    "",
    "POST /v1/conversions/quote -> " + quoteResponse.status + " " + quoteResponse.statusText,
    "RESPONSE HEADERS:",
    JSON.stringify(quoteHeaders, null, 2),
    "RESPONSE BODY:",
    quoteBodyText,
    "",
    "D1 PERSISTED CHALLENGE:",
    JSON.stringify(stored, null, 2),
    "",
    "NO X-PAYMENT HEADER WAS SENT. NO PAYMENT RESERVATION OR SPEND LIMIT WAS CREATED."
  ].join("\n"), "utf8");

  console.log("Track 2 passed: NERITH Worker relayed Hermes 402 and persisted its challenge in local D1.");
  console.log(JSON.stringify({ result: output.result, databaseChecks, challengeAmountAtoms: requirement.maxAmountRequired }, null, 2));
} catch (error) {
  output.result = "FAIL";
  output.completedAt = new Date().toISOString();
  output.errors.push(error instanceof Error ? error.stack ?? error.message : String(error));
  await writeFile(join(evidenceDir, "report.json"), JSON.stringify(output, null, 2), "utf8");
  await writeFile(join(evidenceDir, "wrangler-dev.log"), workerLog, "utf8");
  console.error(output.errors.join("\n"));
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await new Promise(resolve => {
      const timeout = setTimeout(() => { worker.kill("SIGKILL"); resolve(); }, 5000);
      worker.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
}
