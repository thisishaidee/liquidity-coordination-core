import {
  evaluateLiquidity,
  makeOperationId,
  parseTokenAmount,
  formatTokenAmount
} from "./core";

interface Env {
  DB: D1Database;
  ADMIN_BOOTSTRAP_TOKEN?: string;
}

type AgentRow = {
  id: string;
  business_id: string;
  status: string;
  can_use_business_treasury: number;
};

type BalanceRow = {
  balance_id: string;
  wallet_id: string;
  token: string;
  confirmed_atoms: string;
  reserved_atoms: string;
  wallet_scope: string;
  wallet_agent_id: string | null;
  wallet_status: string;
  observed_at: string;
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const configured = env.ADMIN_BOOTSTRAP_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configured || !supplied) return false;
  return constantTimeEqual(await sha256(configured), await sha256(supplied));
}

async function authenticate(request: Request, db: D1Database): Promise<AgentRow | null> {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key) return null;
  const hash = await sha256(key);
  return db.prepare(
    "SELECT id, business_id, status, can_use_business_treasury FROM agents WHERE api_key_hash = ? LIMIT 1"
  ).bind(hash).first<AgentRow>();
}

function newSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function bootstrapBusiness(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const businessName = body.businessName;
  const agentName = body.agentName;
  if (
    typeof businessName !== "string" || businessName.trim().length < 2 || businessName.length > 100 ||
    typeof agentName !== "string" || agentName.trim().length < 2 || agentName.length > 100
  ) {
    return json({ error: "invalid_request", message: "businessName and agentName are required." }, 400);
  }

  const businessId = "biz_" + crypto.randomUUID().replaceAll("-", "");
  const agentId = "agt_" + crypto.randomUUID().replaceAll("-", "");
  const apiKey = newSecret("lci_");
  const apiKeyHash = await sha256(apiKey);
  const canUseBusinessTreasury = body.canUseBusinessTreasury === true ? 1 : 0;

  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO businesses (id, name) VALUES (?, ?)").bind(businessId, businessName.trim()),
      env.DB.prepare(
        "INSERT INTO agents (id, business_id, name, api_key_hash, can_use_business_treasury) VALUES (?, ?, ?, ?, ?)"
      ).bind(agentId, businessId, agentName.trim(), apiKeyHash, canUseBusinessTreasury)
    ]);
  } catch {
    return json({ error: "provisioning_failed" }, 500);
  }

  return json({
    business: { id: businessId, name: businessName.trim() },
    agent: { id: agentId, name: agentName.trim() },
    apiKey,
    warning: "Store this key securely. It is returned once and cannot be retrieved later."
  }, 201);
}

async function registerWallet(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const { businessId, agentId, network, address, scope } = body;
  if (
    typeof businessId !== "string" ||
    network !== "solana" ||
    typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ||
    (scope !== "agent" && scope !== "business") ||
    (scope === "agent" && typeof agentId !== "string") ||
    (scope === "business" && agentId !== undefined && agentId !== null)
  ) {
    return json({ error: "invalid_request", message: "Provide a valid businessId, Solana address and wallet scope." }, 400);
  }

  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);

  if (scope === "agent") {
    const agent = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND business_id = ?")
      .bind(agentId, businessId).first<{ id: string }>();
    if (!agent) return json({ error: "agent_not_found_for_business" }, 404);
  }

  const walletId = "wal_" + crypto.randomUUID().replaceAll("-", "");
  try {
    await env.DB.prepare(
      "INSERT INTO wallets (id, business_id, agent_id, network, address, scope) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(walletId, businessId, scope === "agent" ? agentId : null, network, address, scope).run();
  } catch {
    return json({ error: "wallet_not_registered", message: "Wallet may already be registered." }, 409);
  }

  return json({ walletId, businessId, agentId: scope === "agent" ? agentId : null, network, address, scope }, 201);
}

async function upsertBalanceSnapshot(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const { walletId, token, amount } = body;
  if (
    typeof walletId !== "string" ||
    (token !== "USDC" && token !== "SOL") ||
    typeof amount !== "string" ||
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(amount)
  ) {
    return json({ error: "invalid_request", message: "Provide walletId, token=USDC|SOL and a non-negative decimal amount." }, 400);
  }

  const decimals = token === "USDC" ? 6 : 9;
  let atoms: bigint;
  try {
    atoms = amount === "0" ? 0n : parseTokenAmount(amount, decimals);
  } catch (error) {
    return json({ error: "invalid_amount", message: error instanceof Error ? error.message : "Invalid amount" }, 400);
  }

  const wallet = await env.DB.prepare(
    "SELECT id FROM wallets WHERE id = ? AND network = 'solana' AND status = 'active'"
  ).bind(walletId).first<{ id: string }>();
  if (!wallet) return json({ error: "wallet_not_found" }, 404);

  const balanceId = "bal_" + crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare(`
    INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
    VALUES (?, ?, ?, ?, '0', datetime('now'), 'manual_admin')
    ON CONFLICT(wallet_id, token) DO UPDATE SET
      confirmed_atoms = excluded.confirmed_atoms,
      observed_at = excluded.observed_at,
      source = 'manual_admin'
  `).bind(balanceId, walletId, token, atoms.toString()).run();

  return json({
    walletId,
    token,
    amount,
    decimals,
    source: "manual_admin",
    observedAt: new Date().toISOString(),
    warning: "This is an operator-entered snapshot for controlled testing, not a live on-chain balance."
  }, 201);
}

async function createLiquidityRequest(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const { taskId, network, token, amount, purpose } = body;
  if (
    typeof taskId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(taskId) ||
    network !== "solana" || token !== "USDC" ||
    typeof purpose !== "string" || purpose.trim().length < 3 || purpose.length > 300
  ) {
    return json({ error: "invalid_request", message: "V1 currently accepts Solana USDC requests. Provide taskId, amount and purpose." }, 400);
  }

  let requestedAtoms: bigint;
  try {
    requestedAtoms = parseTokenAmount(amount);
  } catch (error) {
    return json({ error: "invalid_amount", message: error instanceof Error ? error.message : "Invalid amount" }, 400);
  }

  const existing = await env.DB.prepare(
    "SELECT id, status, action FROM operations WHERE agent_id = ? AND task_id = ?"
  ).bind(agent.id, taskId).first<{ id: string; status: string; action: string }>();
  if (existing) {
    return json({ error: "duplicate_task", message: "This agent has already submitted this taskId.", existingOperation: existing }, 409);
  }

  const balances = await env.DB.prepare(`
    SELECT b.id AS balance_id, w.id AS wallet_id, b.token, b.confirmed_atoms,
           b.reserved_atoms, b.observed_at, w.scope AS wallet_scope, w.agent_id AS wallet_agent_id,
           w.status AS wallet_status
    FROM wallet_balances b
    JOIN wallets w ON w.id = b.wallet_id
    WHERE w.business_id = ? AND w.network = 'solana' AND w.status = 'active'
  `).bind(agent.business_id).all<BalanceRow>();

  const eligibleRows = (balances.results ?? []).filter((row) => {
    const ageMs = Date.now() - Date.parse(row.observed_at);
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60 * 1000;
    const authorized =
      (row.wallet_scope === "agent" && row.wallet_agent_id === agent.id) ||
      (row.wallet_scope === "business" && agent.can_use_business_treasury === 1);
    return fresh && authorized;
  });

  const evaluated = eligibleRows.map((row) => {
    const confirmed = BigInt(row.confirmed_atoms);
    const reserved = BigInt(row.reserved_atoms);
    return {
      walletId: row.wallet_id,
      token: row.token,
      availableAtoms: confirmed > reserved ? confirmed - reserved : 0n,
      eligible: true
    };
  });

  const decision = evaluateLiquidity("USDC", requestedAtoms, evaluated);
  const operationId = makeOperationId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

  if (decision.action === "direct_fulfillment") {
    const candidate = eligibleRows
      .filter((row) => row.token === "USDC")
      .map((row) => ({
        row,
        available: BigInt(row.confirmed_atoms) - BigInt(row.reserved_atoms)
      }))
      .filter((item) => item.available >= requestedAtoms)
      .sort((a, b) => a.available > b.available ? -1 : a.available < b.available ? 1 : 0)[0];

    if (!candidate) return json({ error: "balance_changed", message: "Eligible balance changed. Retry the request." }, 409);

    const reservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
    const reserved = await env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + ?
      WHERE id = ?
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= ?
    `).bind(requestedAtoms.toString(), candidate.row.balance_id, requestedAtoms.toString()).run();

    if ((reserved.meta?.changes ?? 0) !== 1) {
      return json({ error: "balance_changed", message: "Funds were reserved by another operation. Retry." }, 409);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO operations
            (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose,
             status, action, available_atoms, shortfall_atoms)
          VALUES (?, ?, ?, ?, 'solana', 'USDC', ?, ?, 'reserved', 'direct_fulfillment', ?, '0')
        `).bind(
          operationId, agent.business_id, agent.id, taskId, requestedAtoms.toString(),
          purpose.trim(), decision.availableAtoms.toString()
        ),
        env.DB.prepare(`
          INSERT INTO reservations (id, operation_id, wallet_balance_id, amount_atoms, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).bind(reservationId, operationId, candidate.row.balance_id, requestedAtoms.toString(), expiresAt)
      ]);
    } catch {
      await env.DB.prepare(
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?"
      ).bind(requestedAtoms.toString(), candidate.row.balance_id, requestedAtoms.toString()).run();
      await env.DB.prepare("DELETE FROM operations WHERE id = ?").bind(operationId).run();
      return json({ error: "reservation_persistence_failed" }, 500);
    }

    return json({
      operationId,
      status: "reserved",
      requested: { network: "solana", token: "USDC", amount: formatTokenAmount(requestedAtoms) },
      liquidity: {
        availableBeforeReservation: formatTokenAmount(decision.availableAtoms),
        reserved: formatTokenAmount(requestedAtoms),
        shortfall: "0"
      },
      action: "direct_fulfillment",
      reservation: { id: reservationId, expiresAt },
      note: "Funds are reserved in the internal ledger, not transferred. A separate approved execution step is still required."
    }, 201);
  }

  const status = decision.action === "conversion_required" ? "awaiting_conversion" : "blocked";
  await env.DB.prepare(`
    INSERT INTO operations
      (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose,
       status, action, available_atoms, shortfall_atoms)
    VALUES (?, ?, ?, ?, 'solana', 'USDC', ?, ?, ?, ?, ?, ?)
  `).bind(
    operationId, agent.business_id, agent.id, taskId, requestedAtoms.toString(),
    purpose.trim(), status, decision.action, decision.availableAtoms.toString(),
    decision.shortfallAtoms.toString()
  ).run();

  return json({
    operationId,
    status,
    requested: { network: "solana", token: "USDC", amount: formatTokenAmount(requestedAtoms) },
    liquidity: {
      available: formatTokenAmount(decision.availableAtoms),
      shortfall: formatTokenAmount(decision.shortfallAtoms)
    },
    action: decision.action,
    eligibleSourceTokens: decision.eligibleSourceTokens,
    note: "No conversion, signing or transfer has occurred."
  }, 201);
}

async function releaseOperation(request: Request, env: Env, operationId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const operation = await env.DB.prepare(
    "SELECT id, status FROM operations WHERE id = ? AND agent_id = ?"
  ).bind(operationId, agent.id).first<{ id: string; status: string }>();
  if (!operation) return json({ error: "operation_not_found" }, 404);
  if (operation.status !== "reserved") return json({ error: "operation_not_releasable", status: operation.status }, 409);

  const reservation = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms FROM reservations WHERE operation_id = ? AND status = 'active' LIMIT 1"
  ).bind(operationId).first<{ id: string; wallet_balance_id: string; amount_atoms: string }>();
  if (!reservation) return json({ error: "active_reservation_not_found" }, 409);

  const amount = BigInt(reservation.amount_atoms);

  // Claim the reservation first. Only one concurrent release can change active -> released.
  const claim = await env.DB.prepare(
    "UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'active'"
  ).bind(reservation.id).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    return json({ error: "reservation_already_released" }, 409);
  }

  const operationClaim = await env.DB.prepare(
    "UPDATE operations SET status = 'released' WHERE id = ? AND status = 'reserved'"
  ).bind(operationId).run();
  if ((operationClaim.meta?.changes ?? 0) !== 1) {
    await env.DB.prepare("UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'released'")
      .bind(reservation.id).run();
    return json({ error: "operation_state_changed" }, 409);
  }

  const debit = await env.DB.prepare(`
    UPDATE wallet_balances
    SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?
    WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?
  `).bind(amount.toString(), reservation.wallet_balance_id, amount.toString()).run();

  if ((debit.meta?.changes ?? 0) !== 1) {
    await env.DB.batch([
      env.DB.prepare("UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'released'")
        .bind(reservation.id),
      env.DB.prepare("UPDATE operations SET status = 'reserved' WHERE id = ? AND status = 'released'")
        .bind(operationId)
    ]);
    return json({ error: "reservation_ledger_mismatch" }, 409);
  }

  return json({ operationId, status: "released", releasedAmount: formatTokenAmount(amount), token: "USDC" });
}

async function expireReservations(env: Env): Promise<{ expired: number; skipped: number }> {
  const due = await env.DB.prepare(`
    SELECT id, operation_id, wallet_balance_id, amount_atoms
    FROM reservations
    WHERE status = 'active' AND julianday(expires_at) <= julianday('now')
    ORDER BY expires_at ASC
    LIMIT 100
  `).all<{ id: string; operation_id: string; wallet_balance_id: string; amount_atoms: string }>();

  let expired = 0;
  let skipped = 0;
  for (const reservation of due.results ?? []) {
    const claim = await env.DB.prepare(`
      UPDATE reservations
      SET status = 'expired', released_at = datetime('now')
      WHERE id = ? AND status = 'active' AND julianday(expires_at) <= julianday('now')
    `).bind(reservation.id).run();

    if ((claim.meta?.changes ?? 0) !== 1) {
      skipped++;
      continue;
    }

    const amount = BigInt(reservation.amount_atoms);
    const debit = await env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?
      WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?
    `).bind(amount.toString(), reservation.wallet_balance_id, amount.toString()).run();

    if ((debit.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare(
        "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'expired'"
      ).bind(reservation.id).run();
      skipped++;
      continue;
    }

    await env.DB.prepare(
      "UPDATE operations SET status = 'expired' WHERE id = ? AND status = 'reserved'"
    ).bind(reservation.operation_id).run();
    expired++;
  }
  return { expired, skipped };
}

async function expireReservationsAdmin(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await expireReservations(env);
  return json({ ...result, message: "Expired reservations were released from the internal ledger." });
}

async function getOperation(request: Request, env: Env, operationId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const operation = await env.DB.prepare(`
    SELECT id, task_id, network, token, amount_atoms, status, action,
           available_atoms, shortfall_atoms, created_at
    FROM operations WHERE id = ? AND agent_id = ? LIMIT 1
  `).bind(operationId, agent.id).first<Record<string, string>>();
  if (!operation) return json({ error: "operation_not_found" }, 404);

  const reservation = await env.DB.prepare(
    "SELECT id, amount_atoms, status, expires_at FROM reservations WHERE operation_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(operationId).first<{ id: string; amount_atoms: string; status: string; expires_at: string }>();

  return json({
    operationId: operation.id,
    taskId: operation.task_id,
    network: operation.network,
    token: operation.token,
    amount: formatTokenAmount(BigInt(operation.amount_atoms)),
    status: operation.status,
    action: operation.action,
    liquidity: {
      available: formatTokenAmount(BigInt(operation.available_atoms)),
      shortfall: formatTokenAmount(BigInt(operation.shortfall_atoms))
    },
    reservation: reservation ? {
      id: reservation.id,
      amount: formatTokenAmount(BigInt(reservation.amount_atoms)),
      status: reservation.status,
      expiresAt: reservation.expires_at
    } : null,
    createdAt: operation.created_at
  });
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await expireReservations(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "liquidity-coordination-api", status: "ok", version: "0.2.0" });
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") return bootstrapBusiness(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/wallets") return registerWallet(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/balances") return upsertBalanceSnapshot(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/reservations/expire") return expireReservationsAdmin(request, env);
    if (request.method === "POST" && url.pathname === "/v1/liquidity/requests") return createLiquidityRequest(request, env);
    const releaseMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)\/release$/);
    if (request.method === "POST" && releaseMatch) return releaseOperation(request, env, releaseMatch[1]);
    const operationMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && operationMatch) return getOperation(request, env, operationMatch[1]);
    return json({ error: "not_found" }, 404);
  }
};
