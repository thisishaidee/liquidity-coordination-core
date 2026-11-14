import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = "http://127.0.0.1:8787";
const wranglerCli = join(process.cwd(), "node_modules", "wrangler", "bin", "wrangler.js");
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
  const result = spawnSync(process.execPath, [wranglerCli, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
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

function expectD1Failure(sql, label) {
  const result = spawnSync(process.execPath, [
    wranglerCli, "d1", "execute", "liquidity-coordination", "--local", "--json", "--command", sql
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }
  });
  const log = [result.stdout ?? "", result.stderr ?? ""].join("\n");
  output.steps[label] = { expectedFailure: true, exitCode: result.status, log: log.slice(-4000) };
  if (!result.error && result.status === 0) {
    throw new Error(label + " unexpectedly succeeded; database guard did not reject the mutation.");
  }
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
  const migrationFiles = (await readdir("migrations"))
    .filter(file => /^\d{4}_[a-z0-9_-]+\.sql$/i.test(file))
    .sort();
  if (migrationFiles.length !== 32) {
    throw new Error("Expected 32 ordered D1 migration files; found " + migrationFiles.length);
  }
  const migrationSql = (await Promise.all(
    migrationFiles.map(async file => "-- " + file + "\n" + await readFile(join("migrations", file), "utf8"))
  )).join("\n\n");
  const migrationFile = join(tmpdir(), "nerith-track2-migrations-" + randomBytes(8).toString("hex") + ".sql");
  await writeFile(migrationFile, migrationSql, "utf8");
  runWrangler(
    ["d1", "execute", "liquidity-coordination", "--local", "--file", migrationFile],
    "applyLocalD1Migrations"
  );

  const walletColumns = queryD1("PRAGMA table_info(wallets)", "inspectWalletSchema");
  const ownershipTables = queryD1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallet_ownership_challenges'", "inspectOwnershipChallengeTable");
  const roleTables = queryD1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'wallet_role_assignments'", "inspectWalletRoleTable");
  const ownershipTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_wallet_ownership_reset_on_identity_change'", "inspectOwnershipResetTrigger");
  const roleOwnershipTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_wallet_role_requires_verified_owner_insert', 'trg_wallet_role_requires_verified_owner_update')", "inspectWalletRoleOwnershipTriggers");
  const fundingLegTable = queryD1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_funding_legs'", "inspectFundingLegTable");
  const reservationColumns = queryD1("PRAGMA table_info(reservations)", "inspectReservationColumns");
  const managedReservationTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_managed_reservation_reserve_balance', 'trg_managed_reservation_release_balance', 'trg_managed_reservation_identity_immutable', 'trg_managed_reservation_active_delete_block', 'trg_managed_fee_reservation_reserve_balance', 'trg_managed_payment_wallet_preposition_reserve')", "inspectManagedReservationTriggers");
  const fundingLegTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_funding_leg_identity_immutable', 'trg_funding_leg_transaction_hash_immutable', 'trg_funding_leg_state_transition', 'trg_funding_leg_submitted_requires_hash', 'trg_funding_leg_confirmed_requires_hash')", "inspectFundingLegTriggers");
  const fundingLegTransactionHashIndex = queryD1("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_funding_legs_transaction_hash'", "inspectFundingLegTransactionHashIndex");
  const finalPaymentTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_final_payment_leg_requires_confirmed_funding', 'trg_final_payment_reservation_requires_confirmed_funding', 'trg_replenished_final_leg_requires_ready_intent', 'trg_replenished_final_reservation_requires_ready_intent')", "inspectFinalPaymentFundingTriggers");
  const activeFundingReservationIndex = queryD1("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_active_managed_reservation_per_funding_leg'", "inspectActiveFundingReservationIndex");
  const paymentIntentTables = queryD1("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('business_payment_policies', 'business_payment_intents')", "inspectBusinessPaymentTables");
  const paymentIntentTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_business_payment_intent_identity_immutable', 'trg_business_payment_intent_state_transition', 'trg_business_payment_intent_scope_insert', 'trg_business_payment_intent_policy_guard')", "inspectBusinessPaymentTriggers");
  const feeLedgerTable = queryD1("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operation_funding_leg_fees'", "inspectFundingLegFeeLedger");
  const feeLedgerTriggers = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_funding_leg_fee_identity_immutable', 'trg_funding_leg_fee_transaction_immutable', 'trg_funding_leg_fee_state_transition', 'trg_funding_leg_fee_submitted_requires_signature', 'trg_funding_leg_fee_reconciled_requires_finalized_fee', 'trg_funding_leg_fee_reconciliation_immutable', 'trg_funding_leg_fee_scope_insert', 'trg_funding_leg_fee_state_matches_leg')", "inspectFundingLegFeeTriggers");
  const paymentIntentColumns = queryD1("PRAGMA table_info(business_payment_intents)", "inspectPaymentIntentFeeBudgetColumn");
  const feeBudgetImmutableTrigger = queryD1("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_business_payment_intent_fee_budget_immutable'", "inspectFeeBudgetImmutableTrigger");
  const schemaChecks = {
    ownershipVerifiedAtColumn: walletColumns.some(row => row.name === "ownership_verified_at"),
    ownershipVerifiedOriginColumn: walletColumns.some(row => row.name === "ownership_verified_origin"),
    ownershipChallengeTable: ownershipTables.length === 1,
    walletRoleAssignmentTable: roleTables.length === 1,
    identityChangeResetTrigger: ownershipTriggers.length === 1,
    roleOwnershipGuards: roleOwnershipTriggers.length === 2,
    fundingLegTable: fundingLegTable.length === 1,
    reservationFundingLegLink: reservationColumns.some(row => row.name === "funding_leg_id"),
    managedReservationSourceColumn: reservationColumns.some(row => row.name === "reservation_source"),
    managedReservationTriggers: managedReservationTriggers.length === 6,
    fundingLegSafetyTriggers: fundingLegTriggers.length === 5,
    uniqueFundingLegTransactionHash: fundingLegTransactionHashIndex.length === 1 && fundingLegTransactionHashIndex[0].sql.includes("CREATE UNIQUE INDEX"),
    finalPaymentFundingGates: finalPaymentTriggers.length === 4,
    uniqueActiveFundingReservation: activeFundingReservationIndex.length === 1 && activeFundingReservationIndex[0].sql.includes("CREATE UNIQUE INDEX"),
    businessPaymentTables: paymentIntentTables.length === 2,
    businessPaymentTriggers: paymentIntentTriggers.length === 4,
    aggregateFeeBudgetColumn: paymentIntentColumns.some(row => row.name === "network_fee_budget_lamports"),
    fundingLegFeeLedger: feeLedgerTable.length === 1,
    fundingLegFeeSafetyTriggers: feeLedgerTriggers.length === 8,
    feeBudgetImmutableTrigger: feeBudgetImmutableTrigger.length === 1
  };
  output.steps.walletOwnershipSchema = { checks: schemaChecks };
  if (Object.values(schemaChecks).some(value => value !== true)) {
    throw new Error("Wallet ownership migration schema verification failed: " + JSON.stringify(schemaChecks));
  }

  const hermesFixture = JSON.parse(await readFile("artifacts/hermes-402/response.json", "utf8"));
  if (hermesFixture.status !== 402 || typeof hermesFixture.body !== "string") {
    throw new Error("Track 1 did not provide a valid live Hermes HTTP 402 fixture.");
  }
  const fixtureChallenge = JSON.parse(hermesFixture.body);
  if (fixtureChallenge?.x402Version !== 1 || !Array.isArray(fixtureChallenge.accepts)) {
    throw new Error("Captured Hermes fixture is not an x402 V1 challenge.");
  }
  const fixtureHeaders = hermesFixture.headers ?? {};
  const replayHeaders = { "content-type": fixtureHeaders["content-type"] ?? "application/json" };
  for (const name of ["x-payment-required", "payment-required", "x-payment-response", "payment-response"]) {
    if (typeof fixtureHeaders[name] === "string") replayHeaders[name] = fixtureHeaders[name];
  }
  const testFixture = Buffer.from(JSON.stringify({
    status: 402,
    body: hermesFixture.body,
    headers: replayHeaders
  })).toString("base64");
  output.steps.hermesFixture = {
    source: "Live unpaid Hermes response captured by Track 1 in this same workflow run",
    status: hermesFixture.status,
    challengeVersion: fixtureChallenge.x402Version,
    bodySha256: createHash("sha256").update(hermesFixture.body).digest("hex")
  };

  const suffix = randomBytes(8).toString("hex");
  const businessId = "biz_" + randomBytes(16).toString("hex");
  const agentId = "agt_" + randomBytes(16).toString("hex");
  const paymentAgentId = "agt_" + randomBytes(16).toString("hex");
  const paymentApiKey = "lci_payment_" + randomBytes(32).toString("hex");
  const paymentApiKeyHash = createHash("sha256").update(paymentApiKey).digest("hex");
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
    INSERT INTO agents (id, business_id, name, api_key_hash, can_use_business_treasury)
      VALUES ('${paymentAgentId}', '${businessId}', 'Business Payment Agent', '${paymentApiKeyHash}', 1);
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
  const managedReserveWalletId = "wal_" + randomBytes(16).toString("hex");
  const managedPaymentWalletId = "wal_" + randomBytes(16).toString("hex");
  const managedReserveBalanceId = "bal_" + randomBytes(16).toString("hex");
  const managedPaymentBalanceId = "bal_" + randomBytes(16).toString("hex");
  const managedPaymentSolBalanceId = "bal_" + randomBytes(16).toString("hex");
  const managedFinalPaymentReservationId = "res_" + randomBytes(16).toString("hex");
  const managedOperationId = "op_" + randomBytes(16).toString("hex");
  const managedLegId = "leg_" + randomBytes(16).toString("hex");
  const managedSecondLegId = "leg_" + randomBytes(16).toString("hex");
  const managedReservationId = "res_" + randomBytes(16).toString("hex");
  const managedSecondReservationId = "res_" + randomBytes(16).toString("hex");
  const managedReserveAddress = "8bN6v5Kj3dQx4sW7mR2pL9cF1aT6uH5eG3iJ7kM9nPq";
  const managedPaymentAddress = "9cP7w6Lm4eRy5tX8nS3qM1dG2bU7vI6fH4jK8lN2oQr";
  const managedSecondReserveWalletId = "wal_" + randomBytes(16).toString("hex");
  const managedSecondReserveBalanceId = "bal_" + randomBytes(16).toString("hex");
  const managedThirdLegId = "leg_" + randomBytes(16).toString("hex");
  const managedFourthLegId = "leg_" + randomBytes(16).toString("hex");
  const managedThirdReservationId = "res_" + randomBytes(16).toString("hex");
  const managedFourthReservationId = "res_" + randomBytes(16).toString("hex");
  const managedFifthLegId = "leg_" + randomBytes(16).toString("hex");
  const managedSixthLegId = "leg_" + randomBytes(16).toString("hex");
  const managedFifthReservationId = "res_" + randomBytes(16).toString("hex");
  const managedSixthReservationId = "res_" + randomBytes(16).toString("hex");
  const managedFinalPaymentLegId = "leg_" + randomBytes(16).toString("hex");
  const managedSecondReserveAddress = "7aM5v4Kj2dQx3sW6mR1pL8cF9aT5uH4eG2iJ6kM8nPq";

  queryD1(`INSERT INTO wallets
    (id, business_id, agent_id, network, address, scope, purpose, ownership_verified_at, ownership_verified_origin)
    VALUES ('${managedReserveWalletId}', '${businessId}', NULL, 'solana', '${managedReserveAddress}', 'business', 'operating', datetime('now'), 'https://neritth.pages.dev')`, "insertManagedReserveWallet");
  queryD1(`INSERT INTO wallets
    (id, business_id, agent_id, network, address, scope, purpose, ownership_verified_at, ownership_verified_origin)
    VALUES ('${managedPaymentWalletId}', '${businessId}', NULL, 'solana', '${managedPaymentAddress}', 'business', 'operating', datetime('now'), 'https://neritth.pages.dev')`, "insertManagedPaymentWallet");
  queryD1(`INSERT INTO wallet_role_assignments (business_id, wallet_id, role, enabled)
    VALUES ('${businessId}', '${managedReserveWalletId}', 'reserve', 1)`, "assignManagedReserveRole");
  queryD1(`INSERT INTO wallet_role_assignments (business_id, wallet_id, role, enabled)
    VALUES ('${businessId}', '${managedPaymentWalletId}', 'payment', 1)`, "assignManagedPaymentRole");
  queryD1(`INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
    VALUES ('${managedReserveBalanceId}', '${managedReserveWalletId}', 'USDC', '5000000', '0', datetime('now'), 'managed_reservation_fixture')`, "insertManagedReserveBalance");
  queryD1(`INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
    VALUES ('${managedPaymentBalanceId}', '${managedPaymentWalletId}', 'USDC', '1000000', '0', datetime('now'), 'managed_reservation_fixture')`, "insertManagedPaymentBalance");
  queryD1(`INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
    VALUES ('${managedPaymentSolBalanceId}', '${managedPaymentWalletId}', 'SOL', '1000000000', '0', datetime('now'), 'managed_reservation_fixture')`, "insertManagedPaymentSolBalance");
  queryD1(`INSERT INTO wallets
    (id, business_id, agent_id, network, address, scope, purpose, ownership_verified_at, ownership_verified_origin)
    VALUES ('${managedSecondReserveWalletId}', '${businessId}', NULL, 'solana', '${managedSecondReserveAddress}', 'business', 'operating', datetime('now'), 'https://neritth.pages.dev')`, "insertManagedSecondReserveWallet");
  queryD1(`INSERT INTO wallet_role_assignments (business_id, wallet_id, role, enabled)
    VALUES ('${businessId}', '${managedSecondReserveWalletId}', 'reserve', 1)`, "assignManagedSecondReserveRole");
  queryD1(`INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
    VALUES ('${managedSecondReserveBalanceId}', '${managedSecondReserveWalletId}', 'USDC', '4000000', '0', datetime('now'), 'managed_reservation_fixture')`, "insertManagedSecondReserveBalance");

  queryD1(`INSERT INTO operations
    (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose, status, action, available_atoms, shortfall_atoms)
    VALUES ('${managedOperationId}', '${businessId}', '${agentId}', 'managed-reservation-test', 'solana', 'USDC', '3000000', 'payment', 'reserved', 'replenish_then_pay', '0', '3000000')`, "insertManagedReservationOperation");
  queryD1(`INSERT INTO operation_funding_legs
    (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id, destination_address, asset_mint, amount_atoms)
    VALUES ('${managedLegId}', '${managedOperationId}', 0, 'reserve_replenishment', '${managedReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '3000000')`, "insertManagedFundingLeg");
  queryD1(`INSERT INTO reservations
    (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
    VALUES ('${managedReservationId}', '${managedOperationId}', '${managedReserveBalanceId}', '3000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedLegId}', 'managed')`, "reserveManagedFundingLeg");
  const reservedAfterInsert = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedReserveBalanceId}'`, "readManagedReservedBalance");
  if (reservedAfterInsert[0]?.reserved_atoms !== "3000000") throw new Error("Managed reservation trigger did not reserve the expected amount.");

  queryD1(`INSERT INTO operation_funding_legs
    (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id, destination_address, asset_mint, amount_atoms)
    VALUES ('${managedSecondLegId}', '${managedOperationId}', 1, 'reserve_replenishment', '${managedReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '3000000')`, "insertSecondManagedFundingLeg");
  let insufficientManagedReservationRejected = false;
  try {
    queryD1(`INSERT INTO reservations
      (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES ('${managedSecondReservationId}', '${managedOperationId}', '${managedReserveBalanceId}', '3000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedSecondLegId}', 'managed')`, "rejectInsufficientManagedReservation");
  } catch (error) {
    insufficientManagedReservationRejected = String(error).includes("managed_reservation_insufficient_balance");
    if (!insufficientManagedReservationRejected) throw error;
  }
  if (!insufficientManagedReservationRejected) throw new Error("Managed reservation accepted more than the confirmed balance.");
  const reservedAfterRejectedInsert = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedReserveBalanceId}'`, "verifyRejectedReservationRollback");
  if (reservedAfterRejectedInsert[0]?.reserved_atoms !== "3000000") throw new Error("Rejected managed reservation changed the existing reservation balance.");

  queryD1(`UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = '${managedReservationId}' AND status = 'active'`, "releaseManagedFundingReservation");
  const reservedAfterRelease = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedReserveBalanceId}'`, "verifyManagedReservationRelease");
  if (reservedAfterRelease[0]?.reserved_atoms !== "0") throw new Error("Managed reservation release did not decrement the aggregate exactly once.");
  const batchReservationOneId = "res_" + randomBytes(16).toString("hex");
  const batchReservationTwoId = "res_" + randomBytes(16).toString("hex");
  let atomicMultiRowReservationRejected = false;
  try {
    queryD1(`INSERT INTO reservations
      (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES
      ('${batchReservationOneId}', '${managedOperationId}', '${managedReserveBalanceId}', '3000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedLegId}', 'managed'),
      ('${batchReservationTwoId}', '${managedOperationId}', '${managedReserveBalanceId}', '3000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedSecondLegId}', 'managed')`, "rejectNonAtomicMultiWalletReservation");
  } catch (error) {
    atomicMultiRowReservationRejected = String(error).includes("managed_reservation_insufficient_balance");
    if (!atomicMultiRowReservationRejected) throw error;
  }
  if (!atomicMultiRowReservationRejected) throw new Error("Multi-row reservation exceeded the confirmed source balance.");
  const afterAtomicFailure = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedReserveBalanceId}'`, "verifyAtomicMultiRowReservationRollback");
  const afterAtomicFailureRows = queryD1(`SELECT COUNT(*) AS count FROM reservations WHERE id IN ('${batchReservationOneId}', '${batchReservationTwoId}')`, "verifyAtomicMultiRowReservationRows");
  if (afterAtomicFailure[0]?.reserved_atoms !== "0" || Number(afterAtomicFailureRows[0]?.count ?? 0) !== 0) {
    throw new Error("Failed multi-row reservation did not roll back every row and balance update.");
  }

  queryD1(`UPDATE operation_funding_legs SET status = 'reserved' WHERE id = '${managedLegId}'`, "fundingLegToReserved");
  queryD1(`UPDATE operation_funding_legs SET status = 'awaiting_signature' WHERE id = '${managedLegId}'`, "fundingLegAwaitingSignature");
  queryD1(`UPDATE operation_funding_legs SET transaction_hash = 'local-test-signature', status = 'submitted' WHERE id = '${managedLegId}'`, "fundingLegSubmitted");
  queryD1(`UPDATE operation_funding_legs SET status = 'confirmed' WHERE id = '${managedLegId}'`, "fundingLegConfirmed");
  let fundingLegRegressionRejected = false;
  try {
    queryD1(`UPDATE operation_funding_legs SET status = 'submitted' WHERE id = '${managedLegId}'`, "rejectFundingLegRegression");
  } catch (error) {
    fundingLegRegressionRejected = String(error).includes("invalid_funding_leg_transition");
    if (!fundingLegRegressionRejected) throw error;
  }
  if (!fundingLegRegressionRejected) throw new Error("Funding leg state machine allowed a confirmed leg to regress.");
  // A valid two-wallet replenishment reserves both sources in one D1 statement.
  queryD1(`INSERT INTO operation_funding_legs
    (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id, destination_address, asset_mint, amount_atoms)
    VALUES
    ('${managedThirdLegId}', '${managedOperationId}', 2, 'reserve_replenishment', '${managedReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2000000'),
    ('${managedFourthLegId}', '${managedOperationId}', 3, 'reserve_replenishment', '${managedSecondReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2000000')`, "insertMultiWalletFundingLegs");
  queryD1(`INSERT INTO reservations
    (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
    VALUES
    ('${managedThirdReservationId}', '${managedOperationId}', '${managedReserveBalanceId}', '2000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedThirdLegId}', 'managed'),
    ('${managedFourthReservationId}', '${managedOperationId}', '${managedSecondReserveBalanceId}', '2000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedFourthLegId}', 'managed')`, "reserveAcrossMultipleWallets");
  const multiWalletReserved = queryD1(`SELECT id, reserved_atoms FROM wallet_balances
    WHERE id IN ('${managedReserveBalanceId}', '${managedSecondReserveBalanceId}') ORDER BY id`, "verifyMultiWalletReservation");
  if (multiWalletReserved.length !== 2 || multiWalletReserved.some(row => row.reserved_atoms !== "2000000")) {
    throw new Error("Atomic multi-wallet reservation did not reserve the expected amount from both source wallets.");
  }
  queryD1(`UPDATE reservations SET status = 'released', released_at = datetime('now')
    WHERE id IN ('${managedThirdReservationId}', '${managedFourthReservationId}') AND status = 'active'`, "releaseMultiWalletReservations");
  const multiWalletReleased = queryD1(`SELECT id, reserved_atoms FROM wallet_balances
    WHERE id IN ('${managedReserveBalanceId}', '${managedSecondReserveBalanceId}') ORDER BY id`, "verifyMultiWalletRelease");
  if (multiWalletReleased.length !== 2 || multiWalletReleased.some(row => row.reserved_atoms !== "0")) {
    throw new Error("Multi-wallet reservation release did not restore both source balances.");
  }

  // The first source can reserve; the second cannot. SQLite must roll back the
  // first trigger update and insert when the second row fails.
  queryD1(`UPDATE wallet_balances SET confirmed_atoms = '1000000' WHERE id = '${managedSecondReserveBalanceId}'`, "reduceSecondReserveForAtomicFailure");
  queryD1(`INSERT INTO operation_funding_legs
    (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id, destination_address, asset_mint, amount_atoms)
    VALUES
    ('${managedFifthLegId}', '${managedOperationId}', 4, 'reserve_replenishment', '${managedReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2000000'),
    ('${managedSixthLegId}', '${managedOperationId}', 5, 'reserve_replenishment', '${managedSecondReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2000000')`, "insertAtomicFailureFundingLegs");
  let crossWalletAtomicFailure = false;
  try {
    queryD1(`INSERT INTO reservations
      (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES
      ('${managedFifthReservationId}', '${managedOperationId}', '${managedReserveBalanceId}', '2000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedFifthLegId}', 'managed'),
      ('${managedSixthReservationId}', '${managedOperationId}', '${managedSecondReserveBalanceId}', '2000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedSixthLegId}', 'managed')`, "rejectCrossWalletAtomicReservation");
  } catch (error) {
    crossWalletAtomicFailure = String(error).includes("managed_reservation_insufficient_balance");
    if (!crossWalletAtomicFailure) throw error;
  }
  const afterCrossWalletFailure = queryD1(`SELECT id, reserved_atoms FROM wallet_balances
    WHERE id IN ('${managedReserveBalanceId}', '${managedSecondReserveBalanceId}') ORDER BY id`, "verifyCrossWalletAtomicRollback");
  const failedCrossWalletRows = queryD1(`SELECT COUNT(*) AS count FROM reservations
    WHERE id IN ('${managedFifthReservationId}', '${managedSixthReservationId}')`, "verifyNoCrossWalletPartialRows");
  if (!crossWalletAtomicFailure || afterCrossWalletFailure.some(row => row.reserved_atoms !== "0") ||
      Number(failedCrossWalletRows[0]?.count ?? 0) !== 0) {
    throw new Error("Cross-wallet reservation failure left a partial reservation or balance update.");
  }
  queryD1(`UPDATE wallet_balances SET confirmed_atoms = '4000000' WHERE id = '${managedSecondReserveBalanceId}'`, "restoreSecondReserveAfterAtomicRollbackTest");

  const managedGateOperationId = "op_" + randomBytes(16).toString("hex");
  const managedGateReserveLegOneId = "leg_" + randomBytes(16).toString("hex");
  const managedGateReserveLegTwoId = "leg_" + randomBytes(16).toString("hex");
  queryD1(`INSERT INTO operations
    (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose, status, action, available_atoms, shortfall_atoms)
    VALUES ('${managedGateOperationId}', '${businessId}', '${agentId}', 'managed-final-payment-gate', 'solana', 'USDC', '4000000', 'payment', 'reserved', 'replenish_then_pay', '0', '4000000')`, "insertFinalPaymentGateOperation");
  queryD1(`INSERT INTO operation_funding_legs
    (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id, destination_address, asset_mint, amount_atoms)
    VALUES
    ('${managedGateReserveLegOneId}', '${managedGateOperationId}', 0, 'reserve_replenishment', '${managedReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2000000'),
    ('${managedGateReserveLegTwoId}', '${managedGateOperationId}', 1, 'reserve_replenishment', '${managedSecondReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '2000000'),
    ('${managedFinalPaymentLegId}', '${managedGateOperationId}', 2, 'final_payment', '${managedPaymentWalletId}', NULL, '7dN4k3Jm2pQx8sW6vR1aT5uH9cF2eG4iL7oP6bK8mZq', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1000000')`, "insertFinalPaymentFundingLegs");
  queryD1(`INSERT INTO business_payment_policies
    (business_id, allowed_mints, allowed_destinations, allowed_conversion_mints, max_transaction_atoms, max_network_fee_lamports, allowed_fee_payer_wallet_ids, max_daily_atoms, max_balance_age_seconds, max_intent_lifetime_seconds, max_slippage_bps, allow_conversion, allow_partial_payment)
    VALUES ('${businessId}', json_array('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), json_array('7dN4k3Jm2pQx8sW6vR1aT5uH9cF2eG4iL7oP6bK8mZq'), json_array(), '100000000', '5000', json_array('${managedPaymentWalletId}'), '500000000', 300, 900, 50, 0, 0)`, "insertBusinessPaymentPolicy");
  queryD1(`INSERT INTO business_payment_intents
    (id, business_id, operation_id, idempotency_key, destination, mint, requested_atoms, payment_atoms,
     fee_payer_wallet_id, network_fee_lamports, action, status, policy_version, policy_snapshot, expires_at)
    VALUES ('bpi_${suffix}', '${businessId}', '${managedGateOperationId}', 'gate-intent-${suffix}',
      '7dN4k3Jm2pQx8sW6vR1aT5uH9cF2eG4iL7oP6bK8mZq',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1000000', '1000000',
      '${managedPaymentWalletId}', '0', 'replenish_then_pay', 'replenishing', 1, '{}', datetime('now', '+15 minutes'))`,
    "insertReplenishmentGateIntent");
  let prematureFinalPaymentReservationRejected = false;
  try {
    queryD1(`INSERT INTO reservations
      (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES ('${managedFinalPaymentReservationId}', '${managedGateOperationId}', '${managedPaymentBalanceId}', '1000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedFinalPaymentLegId}', 'managed')`, "rejectPrematureFinalPaymentReservation");
  } catch (error) {
    prematureFinalPaymentReservationRejected = String(error).includes("final_payment_requires_confirmed_funding");
    if (!prematureFinalPaymentReservationRejected) throw error;
  }
  if (!prematureFinalPaymentReservationRejected) throw new Error("Final payment reservation was allowed before replenishment confirmation.");

  let finalPaymentGateRejected = false;
  try {
    queryD1(`UPDATE operation_funding_legs SET status = 'reserved' WHERE id = '${managedFinalPaymentLegId}'`, "rejectPrematureFinalPayment");
  } catch (error) {
    finalPaymentGateRejected = String(error).includes("final_payment_requires_confirmed_funding");
    if (!finalPaymentGateRejected) throw error;
  }
  if (!finalPaymentGateRejected) throw new Error("Final payment leg was allowed to reserve before funding legs confirmed.");

  for (const [legId, label] of [[managedGateReserveLegOneId, "First"], [managedGateReserveLegTwoId, "Second"]]) {
    queryD1(`UPDATE operation_funding_legs SET status = 'reserved' WHERE id = '${legId}'`, "funding" + label + "LegReserved");
    queryD1(`UPDATE operation_funding_legs SET status = 'awaiting_signature' WHERE id = '${legId}'`, "funding" + label + "LegAwaitingSignature");
    queryD1(`UPDATE operation_funding_legs SET transaction_hash = 'local-' || lower('${label}') || '-signature', status = 'submitted' WHERE id = '${legId}'`, "funding" + label + "LegSubmitted");
    queryD1(`UPDATE operation_funding_legs SET status = 'confirmed' WHERE id = '${legId}'`, "funding" + label + "LegConfirmed");
  }
  let finalPaymentReservationRequiresReservedState = false;
  try {
    queryD1(`INSERT INTO reservations
      (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES ('${managedFinalPaymentReservationId}', '${managedGateOperationId}', '${managedPaymentBalanceId}', '1000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedFinalPaymentLegId}', 'managed')`, "rejectUnreservedFinalPaymentLeg");
  } catch (error) {
    finalPaymentReservationRequiresReservedState = String(error).includes("final_payment_leg_not_reserved");
    if (!finalPaymentReservationRequiresReservedState) throw error;
  }
  if (!finalPaymentReservationRequiresReservedState) throw new Error("Final payment reservation was allowed before its funding leg entered reserved state.");
  let finalPaymentIntentGateRejected = false;
  try {
    queryD1(`UPDATE operation_funding_legs SET status = 'reserved' WHERE id = '${managedFinalPaymentLegId}'`, "rejectFinalPaymentBeforeIntentReady");
  } catch (error) {
    finalPaymentIntentGateRejected = String(error).includes("final_payment_intent_not_ready");
    if (!finalPaymentIntentGateRejected) throw error;
  }
  if (!finalPaymentIntentGateRejected) throw new Error("Final payment leg advanced before its business payment intent was ready.");
  queryD1(`UPDATE business_payment_intents SET status = 'awaiting_signature' WHERE id = 'bpi_${suffix}'`, "markReplenishmentIntentReady");
  queryD1(`UPDATE operation_funding_legs SET status = 'reserved' WHERE id = '${managedFinalPaymentLegId}'`, "allowFinalPaymentAfterFundingConfirmed");
  const finalPaymentLegState = queryD1(`SELECT status FROM operation_funding_legs WHERE id = '${managedFinalPaymentLegId}'`, "verifyFinalPaymentGate");
  if (finalPaymentLegState[0]?.status !== "reserved") throw new Error("Final payment did not become reservable after all funding legs confirmed.");
  queryD1(`INSERT INTO reservations
    (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
    VALUES ('${managedFinalPaymentReservationId}', '${managedGateOperationId}', '${managedPaymentBalanceId}', '1000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedFinalPaymentLegId}', 'managed')`, "reserveFinalPaymentAfterFundingConfirmed");
  const finalPaymentReserved = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedPaymentBalanceId}'`, "verifyFinalPaymentReservation");
  if (finalPaymentReserved[0]?.reserved_atoms !== "1000000") throw new Error("Final payment reservation did not hold the payment wallet balance.");
  queryD1(`UPDATE wallet_balances SET confirmed_atoms = '2000000' WHERE id = '${managedPaymentBalanceId}'`, "provideDuplicateReservationTestHeadroom");
  let duplicateActiveFinalPaymentReservationRejected = false;
  try {
    queryD1(`INSERT INTO reservations
      (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES ('res_duplicate_final_${suffix}', '${managedGateOperationId}', '${managedPaymentBalanceId}', '1000000', 'USDC', 'active', datetime('now', '+15 minutes'), '${managedFinalPaymentLegId}', 'managed')`, "rejectDuplicateActiveFinalPaymentReservation");
  } catch (error) {
    duplicateActiveFinalPaymentReservationRejected = String(error).includes("UNIQUE constraint failed: reservations.funding_leg_id");
    if (!duplicateActiveFinalPaymentReservationRejected) throw error;
  }
  if (!duplicateActiveFinalPaymentReservationRejected) throw new Error("A funding leg accepted more than one active managed reservation.");
  const finalPaymentReservedAfterDuplicate = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedPaymentBalanceId}'`, "verifyDuplicateFinalReservationRollback");
  if (finalPaymentReservedAfterDuplicate[0]?.reserved_atoms !== "1000000") throw new Error("Duplicate final-payment reservation did not roll back its balance hold.");
  queryD1(`UPDATE wallet_balances SET confirmed_atoms = '1000000' WHERE id = '${managedPaymentBalanceId}'`, "restoreDuplicateReservationFixtureBalance");
  queryD1(`UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = '${managedFinalPaymentReservationId}' AND status = 'active'`, "releaseFinalPaymentReservation");
  const finalPaymentReleased = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedPaymentBalanceId}'`, "verifyFinalPaymentReservationRelease");
  if (finalPaymentReleased[0]?.reserved_atoms !== "0") throw new Error("Final payment reservation did not release its balance hold.");

  const businessPaymentIntentId = "bpi_" + randomBytes(16).toString("hex");
  const duplicatePaymentIntentId = "bpi_" + randomBytes(16).toString("hex");
  const duplicatePaymentOperationId = "op_" + randomBytes(16).toString("hex");
  const businessPaymentIntentOperationId = "op_" + randomBytes(16).toString("hex");
  queryD1(`INSERT INTO operations
    (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose, status, action, available_atoms, shortfall_atoms)
    VALUES ('${businessPaymentIntentOperationId}', '${businessId}', '${agentId}', 'business-payment-intent-fixture', 'solana', 'USDC', '1000000', 'payment', 'policy_checked', 'direct_payment', '1000000', '0')`,
    "insertBusinessPaymentIntentOperation");

  queryD1(`INSERT INTO business_payment_intents
    (id, business_id, operation_id, idempotency_key, destination, mint, requested_atoms, payment_atoms, fee_payer_wallet_id, network_fee_lamports, action, status, policy_version, policy_snapshot, expires_at)
    VALUES ('${businessPaymentIntentId}', '${businessId}', '${businessPaymentIntentOperationId}', 'business-idem-12345678', '7dN4k3Jm2pQx8sW6vR1aT5uH9cF2eG4iL7oP6bK8mZq', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1000000', '1000000', '${managedPaymentWalletId}', '5000', 'replenish_then_pay', 'policy_checked', 1, '{}', datetime('now', '+15 minutes'))`, "insertBusinessPaymentIntent");
  queryD1(`INSERT INTO operations
    (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose, status, action, available_atoms, shortfall_atoms)
    VALUES ('${duplicatePaymentOperationId}', '${businessId}', '${agentId}', 'duplicate-business-payment-intent', 'solana', 'USDC', '1000000', 'payment', 'policy_checked', 'direct_payment', '1000000', '0')`, "insertDuplicateIntentOperation");
  let duplicateBusinessIdempotencyRejected = false;
  try {
    queryD1(`INSERT INTO business_payment_intents
      (id, business_id, operation_id, idempotency_key, destination, mint, requested_atoms, payment_atoms, fee_payer_wallet_id, network_fee_lamports, action, status, policy_version, policy_snapshot, expires_at)
      VALUES ('${duplicatePaymentIntentId}', '${businessId}', '${duplicatePaymentOperationId}', 'business-idem-12345678', '7dN4k3Jm2pQx8sW6vR1aT5uH9cF2eG4iL7oP6bK8mZq', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '1000000', '1000000', '${managedPaymentWalletId}', '5000', 'direct_payment', 'policy_checked', 1, '{}', datetime('now', '+15 minutes'))`, "rejectDuplicateBusinessPaymentIdempotency");
  } catch (error) {
    duplicateBusinessIdempotencyRejected = String(error).includes("UNIQUE constraint failed: business_payment_intents.business_id, business_payment_intents.idempotency_key");
    if (!duplicateBusinessIdempotencyRejected) throw error;
  }
  queryD1(`UPDATE business_payment_intents SET status = 'reserved' WHERE id = '${businessPaymentIntentId}'`, "advanceBusinessPaymentIntent");
  let invalidPaymentIntentTransitionRejected = false;
  try {
    queryD1(`UPDATE business_payment_intents SET status = 'policy_checked' WHERE id = '${businessPaymentIntentId}'`, "rejectBusinessPaymentIntentRegression");
  } catch (error) {
    invalidPaymentIntentTransitionRejected = String(error).includes("invalid_business_payment_intent_transition");
    if (!invalidPaymentIntentTransitionRejected) throw error;
  }
  let businessPaymentIntentIdentityImmutable = false;
  try {
    queryD1(`UPDATE business_payment_intents SET destination = 'another-destination' WHERE id = '${businessPaymentIntentId}'`, "rejectBusinessPaymentIntentIdentityMutation");
  } catch (error) {
    businessPaymentIntentIdentityImmutable = String(error).includes("business_payment_intent_identity_immutable");
    if (!businessPaymentIntentIdentityImmutable) throw error;
  }
    let businessPaymentIntentExpiryImmutable = false;
  try {
    queryD1(`UPDATE business_payment_intents SET expires_at = datetime('now', '+2 days') WHERE id = '${businessPaymentIntentId}'`, "rejectBusinessPaymentIntentExpiryMutation");
  } catch (error) {
    businessPaymentIntentExpiryImmutable = String(error).includes("business_payment_intent_identity_immutable");
    if (!businessPaymentIntentExpiryImmutable) throw error;
  }
const businessPaymentIntentCount = queryD1(`SELECT COUNT(*) AS count FROM business_payment_intents WHERE business_id = '${businessId}' AND idempotency_key = 'business-idem-12345678'`, "verifyBusinessPaymentIdempotency");
  if (!duplicateBusinessIdempotencyRejected || !invalidPaymentIntentTransitionRejected || !businessPaymentIntentIdentityImmutable || !businessPaymentIntentExpiryImmutable || Number(businessPaymentIntentCount[0]?.count) !== 1) {
    throw new Error("Business payment intent uniqueness or immutable state guards failed.");
  }
  queryD1(`UPDATE wallet_role_assignments SET minimum_remaining_atoms = '500000', maximum_transfer_atoms = '600000' WHERE wallet_id = '${managedSecondReserveWalletId}' AND role = 'reserve'`, "applyManagedReserveLimits");
  queryD1(`UPDATE wallet_balances SET confirmed_atoms = '1099999' WHERE id = '${managedSecondReserveBalanceId}'`, "setReserveFloorTestBalance");
  const limitedLegIds = ["leg_" + randomBytes(16).toString("hex"), "leg_" + randomBytes(16).toString("hex"), "leg_" + randomBytes(16).toString("hex")];
  const limitedReservationIds = ["res_" + randomBytes(16).toString("hex"), "res_" + randomBytes(16).toString("hex"), "res_" + randomBytes(16).toString("hex")];
  const limitedAmounts = ["700000", "600000", "500000"];
  for (let index = 0; index < limitedLegIds.length; index++) {
    queryD1(`INSERT INTO operation_funding_legs
      (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id, destination_address, asset_mint, amount_atoms)
      VALUES ('${limitedLegIds[index]}', '${managedOperationId}', ${7 + index}, 'reserve_replenishment', '${managedSecondReserveWalletId}', '${managedPaymentWalletId}', '${managedPaymentAddress}', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', '${limitedAmounts[index]}')`, "insertReserveLimitFundingLeg" + index);
  }
  let reserveTransferCapRejected = false;
  try {
    queryD1(`INSERT INTO reservations (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES ('${limitedReservationIds[0]}', '${managedOperationId}', '${managedSecondReserveBalanceId}', '700000', 'USDC', 'active', datetime('now', '+15 minutes'), '${limitedLegIds[0]}', 'managed')`, "rejectReserveTransferAboveCap");
  } catch (error) {
    reserveTransferCapRejected = String(error).includes("managed_reservation_wallet_not_authorized");
    if (!reserveTransferCapRejected) throw error;
  }
  let reserveFloorRejected = false;
  try {
    queryD1(`INSERT INTO reservations (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES ('${limitedReservationIds[1]}', '${managedOperationId}', '${managedSecondReserveBalanceId}', '600000', 'USDC', 'active', datetime('now', '+15 minutes'), '${limitedLegIds[1]}', 'managed')`, "rejectReserveFloorBreach");
  } catch (error) {
    reserveFloorRejected = String(error).includes("managed_reservation_insufficient_balance");
    if (!reserveFloorRejected) throw error;
  }
  queryD1(`INSERT INTO reservations (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
    VALUES ('${limitedReservationIds[2]}', '${managedOperationId}', '${managedSecondReserveBalanceId}', '500000', 'USDC', 'active', datetime('now', '+15 minutes'), '${limitedLegIds[2]}', 'managed')`, "reserveWithinFloorAndCap");
  queryD1(`UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = '${limitedReservationIds[2]}'`, "releaseReserveLimitTestHold");
  queryD1(`UPDATE wallet_role_assignments SET minimum_remaining_atoms = '0', maximum_transfer_atoms = NULL WHERE wallet_id = '${managedSecondReserveWalletId}' AND role = 'reserve'`, "restoreManagedReserveLimits");
  queryD1(`UPDATE wallet_balances SET confirmed_atoms = '4000000' WHERE id = '${managedSecondReserveBalanceId}'`, "restoreReserveTestBalance");
  const reserveLimitBalance = queryD1(`SELECT reserved_atoms FROM wallet_balances WHERE id = '${managedSecondReserveBalanceId}'`, "verifyReserveLimitRelease");
  if (!reserveTransferCapRejected || !reserveFloorRejected || reserveLimitBalance[0]?.reserved_atoms !== "0") {
    throw new Error("Managed reserve floor or transfer cap enforcement failed.");
  }
  output.steps.managedReservationBehavior = {
    initialReservationAtoms: reservedAfterInsert[0].reserved_atoms,
    rejectedOverReservation: insufficientManagedReservationRejected,
    reservedAfterRejectedInsert: reservedAfterRejectedInsert[0].reserved_atoms,
    reservedAfterRelease: reservedAfterRelease[0].reserved_atoms,
    atomicMultiRowReservationRejected,
    reservedAfterAtomicFailure: afterAtomicFailure[0].reserved_atoms,
    fundingLegConfirmed: true,
    confirmedLegRegressionRejected: fundingLegRegressionRejected,
    multiWalletReservationSucceeded: multiWalletReserved.length === 2,
    multiWalletReleaseRestoredBalances: multiWalletReleased.every(row => row.reserved_atoms === "0"),
    crossWalletAtomicFailureRejected: crossWalletAtomicFailure,
    crossWalletAtomicRollbackRestoredBalances: afterCrossWalletFailure.every(row => row.reserved_atoms === "0"),
    finalPaymentBlockedUntilFundingConfirmed: finalPaymentGateRejected,
    prematureFinalPaymentReservationRejected,
    finalPaymentReservationRequiresReservedState,
    finalPaymentAllowedAfterFundingConfirmed: finalPaymentLegState[0]?.status === "reserved",
    finalPaymentReservationReleased: finalPaymentReleased[0]?.reserved_atoms === "0",
    reserveTransferCapRejected,
    reserveFloorRejected,
    duplicateBusinessIdempotencyRejected,
    invalidPaymentIntentTransitionRejected,
    businessPaymentIntentIdentityImmutable
  };


  worker = spawn(process.execPath, [
    wranglerCli, "dev", "--local", "--port", "8787", "--ip", "127.0.0.1",
    "--var", "NERITH_TEST_MODE:true",
    "--var", "HERMES_TEST_402_FIXTURE:" + testFixture
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" }
  });
  worker.stdout.on("data", chunk => { workerLog += chunk.toString(); });
  worker.stderr.on("data", chunk => { workerLog += chunk.toString(); });

  output.steps.localWorkerHealth = await waitForWorker(worker, () => workerLog);

  const authHeaders = {
    authorization: "Bearer " + apiKey,
    "content-type": "application/json"
  };
  const paymentAuthHeaders = {
    authorization: "Bearer " + paymentApiKey,
    "content-type": "application/json"
  };
  const incomingPaymentHeaderPresent = Object.keys(authHeaders)
    .some(name => name.toLowerCase() === "x-payment");
  output.steps.incomingPaymentHeaderCheck = { present: incomingPaymentHeaderPresent };
  if (incomingPaymentHeaderPresent) throw new Error("Test request unexpectedly contains X-PAYMENT.");

  const directPaymentPayload = {
    taskId: "direct-payment-" + suffix,
    idempotencyKey: "direct-idem-" + suffix,
    destination: "7dN4k3Jm2pQx8sW6vR1aT5uH9cF2eG4iL7oP6bK8mZq",
    amount: "0.5",
    feePayerWalletId: managedPaymentWalletId,
    networkFeeLamports: "5000"
  };
  const invalidDestinationResponse = await fetch(baseUrl + "/v1/payments/prepare", {
    method: "POST", headers: paymentAuthHeaders,
    body: JSON.stringify({ ...directPaymentPayload, taskId: "invalid-destination-" + suffix,
      idempotencyKey: "invalid-destination-" + suffix, destination: "not-a-solana-address" })
  });
  if (invalidDestinationResponse.status !== 400) throw new Error("Invalid Solana destination was not rejected before payment preparation.");
  const directPaymentResponse = await fetch(baseUrl + "/v1/payments/prepare", {
    method: "POST", headers: paymentAuthHeaders, body: JSON.stringify(directPaymentPayload)
  });
  const directPaymentBody = await directPaymentResponse.json();
  if (directPaymentResponse.status !== 201 || directPaymentBody.action !== "direct_payment" || directPaymentBody.status !== "reserved") {
    throw new Error("Direct business payment preparation failed: " + JSON.stringify(directPaymentBody));
  }
  const directPaymentReservation = queryD1(`SELECT r.amount_atoms, r.reservation_source, l.kind, l.status, b.reserved_atoms
    FROM reservations r JOIN operation_funding_legs l ON l.id = r.funding_leg_id
    JOIN wallet_balances b ON b.id = r.wallet_balance_id WHERE r.operation_id = '${directPaymentBody.operationId}'`, "verifyDirectPaymentReservation");
  if (directPaymentReservation.length !== 1 || directPaymentReservation[0].amount_atoms !== "500000" ||
      directPaymentReservation[0].reservation_source !== "managed" || directPaymentReservation[0].kind !== "final_payment" ||
      directPaymentReservation[0].status !== "reserved" || directPaymentReservation[0].reserved_atoms !== "500000") {
    throw new Error("Direct payment did not create a correctly guarded payment-wallet reservation.");
  }
  const directFeeReservation = queryD1(`SELECT r.amount_atoms, r.token, r.reservation_source, b.reserved_atoms
    FROM reservations r JOIN wallet_balances b ON b.id = r.wallet_balance_id
    WHERE r.operation_id = '${directPaymentBody.operationId}' AND r.token = 'SOL'`, "verifyDirectPaymentFeeReservation");
  if (directFeeReservation.length !== 1 || directFeeReservation[0].amount_atoms !== "5000" ||
      directFeeReservation[0].reservation_source !== "managed_fee" || directFeeReservation[0].reserved_atoms !== "5000") {
    throw new Error("Direct payment did not reserve the approved SOL network fee.");
  }
  const directFeeReservationCount = queryD1(`SELECT COUNT(*) AS count FROM reservations WHERE operation_id = '${directPaymentBody.operationId}' AND token = 'SOL' AND reservation_source = 'managed_fee'`, "verifyFeeReservationIdempotency");
  if (Number(directFeeReservationCount[0]?.count) !== 1) throw new Error("Idempotent replay duplicated the SOL fee reservation.");
  const directFeeLedger = queryD1(`SELECT f.status, f.maximum_fee_lamports, f.funding_leg_id
    FROM operation_funding_leg_fees f WHERE f.operation_id = '${directPaymentBody.operationId}'`, "verifyDirectPaymentFeeLedger");
  if (directFeeLedger.length !== 1 || directFeeLedger[0].status !== "reserved" ||
      directFeeLedger[0].maximum_fee_lamports !== "5000" || !directFeeLedger[0].funding_leg_id) {
    throw new Error("Direct payment did not create exactly one per-leg fee ledger entry.");
  }
  const directReplayResponse = await fetch(baseUrl + "/v1/payments/prepare", {
    method: "POST", headers: paymentAuthHeaders, body: JSON.stringify(directPaymentPayload)
  });
  const directReplayBody = await directReplayResponse.json();
  if (directReplayResponse.status !== 200 || directReplayBody.reused !== true || directReplayBody.intentId !== directPaymentBody.intentId) {
    throw new Error("Business payment idempotent replay did not return the original intent.");
  }
  const directConflictResponse = await fetch(baseUrl + "/v1/payments/prepare", {
    method: "POST", headers: paymentAuthHeaders, body: JSON.stringify({ ...directPaymentPayload, amount: "0.6" })
  });
  if (directConflictResponse.status !== 409) throw new Error("Payment idempotency key accepted a changed request payload.");
  const unverifiedCompleteResponse = await fetch(baseUrl + "/v1/operations/" + directPaymentBody.operationId + "/complete", {
    method: "POST", headers: paymentAuthHeaders
  });
  if (unverifiedCompleteResponse.status !== 409) throw new Error("Agent-reported completion bypassed on-chain payment confirmation.");
  const releaseDirectPaymentResponse = await fetch(baseUrl + "/v1/operations/" + directPaymentBody.operationId + "/release", {
    method: "POST", headers: paymentAuthHeaders
  });
  if (releaseDirectPaymentResponse.status !== 200) throw new Error("Direct payment reservations could not be safely released: " + await releaseDirectPaymentResponse.text());
  const releasedDirectPayment = queryD1(`SELECT i.status, usdc.reserved_atoms AS usdc_reserved, sol.reserved_atoms AS sol_reserved
    FROM business_payment_intents i
    JOIN wallet_balances usdc ON usdc.wallet_id = '${managedPaymentWalletId}' AND usdc.token = 'USDC'
    JOIN wallet_balances sol ON sol.wallet_id = '${managedPaymentWalletId}' AND sol.token = 'SOL'
    WHERE i.id = '${directPaymentBody.intentId}'`, "verifyDirectPaymentRelease");
  if (releasedDirectPayment[0]?.status !== "cancelled" || releasedDirectPayment[0]?.usdc_reserved !== "0" || releasedDirectPayment[0]?.sol_reserved !== "0") {
    throw new Error("Payment release did not cancel the intent and release both USDC and SOL fee holds.");
  }

  const multiWalletPaymentResponse = await fetch(baseUrl + "/v1/payments/prepare", {
    method: "POST", headers: paymentAuthHeaders, body: JSON.stringify({
      taskId: "multi-wallet-payment-" + suffix,
      idempotencyKey: "multi-idem-" + suffix,
      destination: directPaymentPayload.destination, amount: "8",
      feePayerWalletId: managedPaymentWalletId, networkFeeLamports: "5000"
    })
  });
  const multiWalletPaymentBody = await multiWalletPaymentResponse.json();
  if (multiWalletPaymentResponse.status !== 201 || multiWalletPaymentBody.action !== "replenish_then_pay" ||
      multiWalletPaymentBody.status !== "replenishing" || multiWalletPaymentBody.fundingLegs?.filter(leg => leg.kind === "reserve_replenishment").length !== 2) {
    throw new Error("Multi-wallet payment preparation did not create two replenishment legs: " + JSON.stringify(multiWalletPaymentBody));
  }
  const paymentIntentDetailResponse = await fetch(baseUrl + "/v1/payments/" + multiWalletPaymentBody.intentId, {
    method: "GET", headers: paymentAuthHeaders
  });
  const paymentIntentDetail = await paymentIntentDetailResponse.json();
  if (paymentIntentDetailResponse.status !== 200 || paymentIntentDetail.status !== "replenishing" ||
      paymentIntentDetail.fundingLegs?.filter(leg => leg.kind === "reserve_replenishment").length !== 2 ||
      paymentIntentDetail.fundingLegs?.find(leg => leg.kind === "final_payment")?.status !== "planned" ||
      paymentIntentDetail.networkFeeLamports !== "5000" ||
      paymentIntentDetail.networkFeeBudgetLamports !== "15000" ||
      paymentIntentDetail.fundingLegs?.some(leg => leg.networkFee?.status !== "reserved" || leg.networkFee?.maximumLamports !== "5000") ||
      !paymentIntentDetail.reservations?.some(reservation => reservation.source === "managed_fee" && reservation.token === "SOL" && reservation.amountAtoms === "15000")) {
    throw new Error("Agent payment detail endpoint did not return the scoped funding and fee reservation state.");
  }
  const prepositionHold = queryD1(`SELECT r.amount_atoms, r.funding_leg_id, r.reservation_source, b.reserved_atoms
    FROM reservations r JOIN wallet_balances b ON b.id = r.wallet_balance_id
    WHERE r.operation_id = '${multiWalletPaymentBody.operationId}' AND r.token = 'USDC' AND r.funding_leg_id IS NULL`, "verifyPaymentWalletPrepositionHold");
  const multiFeeHold = queryD1(`SELECT r.amount_atoms, b.reserved_atoms
    FROM reservations r JOIN wallet_balances b ON b.id = r.wallet_balance_id
    WHERE r.operation_id = '${multiWalletPaymentBody.operationId}' AND r.token = 'SOL'
      AND r.reservation_source = 'managed_fee' AND r.status = 'active'`, "verifyAggregateMultiLegFeeHold");
  const multiFeeLedger = queryD1(`SELECT status, maximum_fee_lamports
    FROM operation_funding_leg_fees WHERE operation_id = '${multiWalletPaymentBody.operationId}'`, "verifyMultiLegFeeLedger");
  if (multiFeeHold.length !== 1 || multiFeeHold[0].amount_atoms !== "15000" ||
      multiFeeHold[0].reserved_atoms !== "15000" || multiFeeLedger.length !== 3 ||
      multiFeeLedger.some(row => row.status !== "reserved" || row.maximum_fee_lamports !== "5000")) {
    throw new Error("Multi-leg fee budget was not reserved and recorded for all three transactions.");
  }

  const guardedFeeLegId = multiWalletPaymentBody.fundingLegs[0].id;
  expectD1Failure(
    `UPDATE business_payment_intents SET network_fee_budget_lamports = '1' WHERE id = '${multiWalletPaymentBody.intentId}'`,
    "rejectFeeBudgetMutation"
  );
  expectD1Failure(
    `UPDATE operation_funding_leg_fees SET maximum_fee_lamports = '1' WHERE funding_leg_id = '${guardedFeeLegId}'`,
    "rejectPerLegFeeCapMutation"
  );
  expectD1Failure(
    `UPDATE operation_funding_leg_fees SET transaction_hash = 'invalid_signature_binding', status = 'submitted' WHERE funding_leg_id = '${guardedFeeLegId}'`,
    "rejectFeeSubmissionBeforeFundingLegSubmission"
  );
  expectD1Failure(
    `UPDATE operation_funding_leg_fees SET status = 'reconciled' WHERE funding_leg_id = '${guardedFeeLegId}'`,
    "rejectFeeReconciliationWithoutFinalizedEvidence"
  );
  if (prepositionHold.length !== 1 || prepositionHold[0].amount_atoms !== "1000000" ||
      prepositionHold[0].reservation_source !== "managed" || prepositionHold[0].reserved_atoms !== "1000000") {
    throw new Error("Existing payment-wallet liquidity was not held while reserve replenishment is in flight.");
  }
  const multiWalletPaymentRows = queryD1(`SELECT l.kind, l.status, r.amount_atoms, b.wallet_id, b.reserved_atoms
    FROM operation_funding_legs l JOIN reservations r ON r.funding_leg_id = l.id
    JOIN wallet_balances b ON b.id = r.wallet_balance_id WHERE l.operation_id = '${multiWalletPaymentBody.operationId}'
    ORDER BY l.leg_index`, "verifyMultiWalletPaymentReservations");
  if (multiWalletPaymentRows.length !== 2 || multiWalletPaymentRows.some(row => row.kind !== "reserve_replenishment" || row.status !== "reserved") ||
      multiWalletPaymentRows.reduce((sum, row) => sum + BigInt(row.amount_atoms), 0n) !== 7000000n) {
    throw new Error("Multi-wallet payment reservations did not match the planned 7 USDC shortfall.");
  }
  const unreservedFinalLeg = queryD1(`SELECT status FROM operation_funding_legs WHERE operation_id = '${multiWalletPaymentBody.operationId}' AND kind = 'final_payment'`, "verifyFinalPaymentWaitsForReplenishment");
  if (unreservedFinalLeg[0]?.status !== "planned") throw new Error("Final payment was not held behind replenishment confirmation.");
  const releaseMultiWalletPaymentResponse = await fetch(baseUrl + "/v1/operations/" + multiWalletPaymentBody.operationId + "/release", {
    method: "POST", headers: paymentAuthHeaders
  });
  if (releaseMultiWalletPaymentResponse.status !== 200) throw new Error("Multi-wallet payment reservations could not be released.");
  const releasedMultiWalletPayment = queryD1(`SELECT i.status,
      (SELECT COUNT(*) FROM reservations r WHERE r.operation_id = i.operation_id AND r.status = 'active') AS active_holds
    FROM business_payment_intents i WHERE i.id = '${multiWalletPaymentBody.intentId}'`, "verifyMultiWalletPaymentRelease");
  const releasedPaymentWalletBalances = queryD1(`SELECT token, reserved_atoms FROM wallet_balances
    WHERE wallet_id IN ('${managedPaymentWalletId}', '${managedReserveWalletId}', '${managedSecondReserveWalletId}')`, "verifyMultiWalletPaymentWalletHoldsReleased");
  if (releasedMultiWalletPayment[0]?.status !== "cancelled" || Number(releasedMultiWalletPayment[0]?.active_holds) !== 0 ||
      releasedPaymentWalletBalances.some(row => row.reserved_atoms !== "0")) {
    throw new Error("Releasing the multi-wallet payment did not release preposition, reserve and fee holds exactly once.");
  }
  output.steps.businessPaymentPreparation = {
    networkFeeReservedAtoms: directFeeReservation[0].amount_atoms,
    paymentWalletPrepositionAtoms: prepositionHold[0].amount_atoms,
    multiWalletPaymentReleaseVerified: releasedMultiWalletPayment[0]?.status === "cancelled" && Number(releasedMultiWalletPayment[0]?.active_holds) === 0,
    directPaymentPrepared: true,
    directPaymentReservationAtoms: directPaymentReservation[0].amount_atoms,
    idempotentReplayReusedOriginal: directReplayBody.reused === true,
    changedIdempotencyPayloadRejected: directConflictResponse.status === 409,
    multiWalletReplenishmentLegs: multiWalletPaymentBody.fundingLegs.filter(leg => leg.kind === "reserve_replenishment").length,
    multiWalletReservedAtoms: multiWalletPaymentRows.reduce((sum, row) => sum + BigInt(row.amount_atoms), 0n).toString(),
    finalPaymentHeldUntilReplenishment: unreservedFinalLeg[0]?.status === "planned"
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

  // The Worker fixture branch validates the actual payload assembled by requestSwapQuote.
  // Its marker is emitted only after every expected field passes inside proxyHermes.
  const outgoingRequestValidationMarker = "nerith_test_hermes_request_validated";
  const outgoingRequestValidated = workerLog.includes(outgoingRequestValidationMarker);
  output.steps.hermesOutgoingRequestValidation = {
    passed: outgoingRequestValidated,
    expected: {
      path: "/v1/swap/quote",
      inputToken: "So11111111111111111111111111111111111111112",
      inputAmount: "1000000000",
      inputChain: "sol",
      outputToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      outputChain: "sol",
      userAddress: operatingAddress,
      slippageBps: 50
    }
  };
  if (!outgoingRequestValidated) {
    throw new Error("Worker did not validate the expected outgoing Hermes quote payload. Worker log: " + workerLog.slice(-3000));
  }

  output.steps.workerQuoteRelay = {
    upstream: "CI-gated fixture replay of the actual live Hermes 402 response captured by Track 1",
    incomingRequestHadPaymentHeader: incomingPaymentHeaderPresent,
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
    "NERITH LOCAL WORKER -> CAPTURED LIVE HERMES 402 FIXTURE",
    "Environment: GitHub Actions runner, Wrangler local mode, local D1 only",
    "The upstream body is the exact unpaid HTTP 402 response captured from live Hermes by Track 1 in this same workflow run. Local Wrangler could not reach external Hermes or a loopback mock, so a CI-only, gated fixture is injected into the local Worker for the relay/persistence test.",
    "The Worker validated the actual outgoing Hermes quote payload before replaying the fixture:",
    JSON.stringify(output.steps.hermesOutgoingRequestValidation, null, 2),
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
