import { evaluateLiquidity, makeOperationId, parseTokenAmount, formatTokenAmount } from "./core";

interface Env {
  DB: D1Database;
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
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authenticate(request: Request, db: D1Database): Promise<AgentRow | null> {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key) return null;
  const hash = await sha256(key);
  return await db.prepare(
    "SELECT id, business_id, status, can_use_business_treasury FROM agents WHERE api_key_hash = ? LIMIT 1"
  ).bind(hash).first<AgentRow>();
}

async function createLiquidityRequest(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const { taskId, network, token, amount, purpose } = body;
  if (
    typeof taskId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(taskId) ||
    network !== "solana" ||
    token !== "USDC" ||
    typeof purpose !== "string" || purpose.trim().length < 3 || purpose.length > 300
  ) {
    return json({ error: "invalid_request", message: "V1 currently accepts network=solana and token=USDC only; provide taskId, amount and purpose." }, 400);
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
           b.reserved_atoms, w.scope AS wallet_scope, w.agent_id AS wallet_agent_id,
           w.status AS wallet_status
    FROM wallet_balances b
    JOIN wallets w ON w.id = b.wallet_id
    WHERE w.business_id = ? AND w.network = ? AND w.status = 'active'
  `).bind(agent.business_id, network).all<BalanceRow>();

  const evaluated = (balances.results ?? []).map((row) => {
    const isAgentWallet = row.wallet_scope === "agent" && row.wallet_agent_id === agent.id;
    const isAuthorizedBusinessWallet = row.wallet_scope === "business" && agent.can_use_business_treasury === 1;
    const confirmed = BigInt(row.confirmed_atoms);
    const reserved = BigInt(row.reserved_atoms);
    return {
      walletId: row.wallet_id,
      token: row.token,
      availableAtoms: confirmed > reserved ? confirmed - reserved : 0n,
      eligible: isAgentWallet || isAuthorizedBusinessWallet
    };
  });

  const decision = evaluateLiquidity(token, requestedAtoms, evaluated);
  const id = makeOperationId();
  const status = decision.action === "direct_fulfillment" ? "ready_for_fulfillment" : "evaluating";

  try {
    await env.DB.prepare(`
      INSERT INTO operations
        (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose,
         status, action, available_atoms, shortfall_atoms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, agent.business_id, agent.id, taskId, network, token, requestedAtoms.toString(),
      purpose.trim(), status, decision.action, decision.availableAtoms.toString(),
      decision.shortfallAtoms.toString()
    ).run();
  } catch {
    return json({ error: "operation_not_created", message: "Could not persist operation. Check task uniqueness and database state." }, 409);
  }

  return json({
    operationId: id,
    status,
    requested: { network, token, amount: formatTokenAmount(requestedAtoms) },
    liquidity: {
      available: formatTokenAmount(decision.availableAtoms),
      shortfall: formatTokenAmount(decision.shortfallAtoms)
    },
    action: decision.action,
    eligibleSourceTokens: decision.eligibleSourceTokens,
    note: "Decision only: this endpoint does not reserve, swap, sign, or transfer funds."
  }, 201);
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
    createdAt: operation.created_at
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "liquidity-coordination-api", status: "ok", version: "0.1.0" });
    }
    if (request.method === "POST" && url.pathname === "/v1/liquidity/requests") {
      return createLiquidityRequest(request, env);
    }
    const operationMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && operationMatch) return getOperation(request, env, operationMatch[1]);
    return json({ error: "not_found" }, 404);
  }
};
