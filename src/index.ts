import { dashboardHtml } from "./dashboard";
import {
  evaluateLiquidity,
  makeOperationId,
  parseTokenAmount,
  formatTokenAmount
} from "./core";

interface Env {
  DB: D1Database;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  SOLANA_RPC_URL?: string;
  SOLANA_USDC_MINT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
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

async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
  } catch {
    // Notifications are best-effort and must never roll back a liquidity operation.
  }
}

async function notifyBusiness(env: Env, businessId: string, message: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    const connections = await env.DB.prepare(
      "SELECT chat_id FROM telegram_connections WHERE business_id = ? AND status = 'active'"
    ).bind(businessId).all<{ chat_id: string }>();
    await Promise.all((connections.results ?? []).map((connection) =>
      sendTelegramMessage(env, connection.chat_id, message)
    ));
  } catch {
    // Telegram is an optional notification channel, not part of transaction correctness.
  }
}

async function createTelegramLinkCode(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string") return json({ error: "invalid_request" }, 400);

  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(body.businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "telegram_not_configured", message: "Configure bot token, username and webhook secret first." }, 409);
  }

  const code = newSecret("");
  const codeHash = await sha256(code);
  const linkId = "tlg_" + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO telegram_link_codes (id, business_id, code_hash, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(linkId, business.id, codeHash, expiresAt).run();

  return json({
    linkId,
    code,
    expiresAt,
    deepLink: `https://t.me/${env.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}?start=${code}`,
    instruction: "Open the bot link from the Telegram account that should receive business alerts. This code works once and expires in 15 minutes."
  }, 201);
}

async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !constantTimeEqual(secret, supplied)) return json({ error: "unauthorized" }, 401);

  const update = await readJson(request);
  if (!update) return json({ error: "invalid_update" }, 400);
  const message = update.message as {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string };
  } | undefined;
  const text = message?.text ?? "";
  const chatId = message?.chat?.id === undefined ? "" : String(message.chat.id);
  const userId = message?.from?.id === undefined ? "" : String(message.from.id);
  const match = text.match(/^\/(?:start|link)\s+([a-f0-9]{64})$/i);

  if (!match || !chatId || !userId || message?.chat?.type !== "private") {
    if (chatId) await sendTelegramMessage(env, chatId, "To connect this chat, ask your business administrator for a one-time linking invitation.");
    return json({ ok: true });
  }

  const codeHash = await sha256(match[1]);
  const linkCode = await env.DB.prepare(
    "SELECT id, business_id FROM telegram_link_codes WHERE code_hash = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')"
  ).bind(codeHash).first<{ id: string; business_id: string }>();
  if (!linkCode) {
    await sendTelegramMessage(env, chatId, "That invitation is invalid or expired. Ask your business administrator for a new one.");
    return json({ ok: true });
  }

  const claim = await env.DB.prepare(
    "UPDATE telegram_link_codes SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')"
  ).bind(linkCode.id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return json({ ok: true });

  try {
    await env.DB.prepare(
      "INSERT INTO telegram_connections (id, business_id, chat_id, telegram_user_id) VALUES (?, ?, ?, ?) ON CONFLICT(business_id, chat_id, telegram_user_id) DO UPDATE SET status = 'active'"
    ).bind("tg_" + crypto.randomUUID().replaceAll("-", ""), linkCode.business_id, chatId, userId).run();
  } catch {
    await env.DB.prepare("UPDATE telegram_link_codes SET consumed_at = NULL WHERE id = ?")
      .bind(linkCode.id).run();
    await sendTelegramMessage(env, chatId, "We couldn't finish linking this chat. Please try the invitation again.");
    return json({ ok: true });
  }

  await sendTelegramMessage(env, chatId, "This Telegram chat is now connected to your business liquidity alerts.");
  return json({ ok: true, linked: true });
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

async function provisionAgent(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string" || typeof body.agentName !== "string" ||
      body.agentName.trim().length < 2 || body.agentName.length > 100) {
    return json({ error: "invalid_request", message: "Provide businessId and agentName." }, 400);
  }

  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(body.businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);

  const agentId = "agt_" + crypto.randomUUID().replaceAll("-", "");
  const apiKey = newSecret("lci_");
  const apiKeyHash = await sha256(apiKey);
  const canUseBusinessTreasury = body.canUseBusinessTreasury === true ? 1 : 0;
  await env.DB.prepare(
    "INSERT INTO agents (id, business_id, name, api_key_hash, can_use_business_treasury) VALUES (?, ?, ?, ?, ?)"
  ).bind(agentId, business.id, body.agentName.trim(), apiKeyHash, canUseBusinessTreasury).run();

  return json({
    agent: { id: agentId, name: body.agentName.trim(), canUseBusinessTreasury: Boolean(canUseBusinessTreasury) },
    apiKey,
    warning: "Store this key securely. It is returned once and cannot be retrieved later."
  }, 201);
}

async function listBusinessAgents(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  if (!businessId) return json({ error: "business_id_required" }, 400);
  const agents = await env.DB.prepare(
    "SELECT id, name, status, can_use_business_treasury, created_at FROM agents WHERE business_id = ? ORDER BY created_at ASC"
  ).bind(businessId).all<{
    id: string;
    name: string;
    status: string;
    can_use_business_treasury: number;
    created_at: string;
  }>();
  return json({
    agents: (agents.results ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status,
      canUseBusinessTreasury: agent.can_use_business_treasury === 1,
      createdAt: agent.created_at
    }))
  });
}

async function rotateAgentKey(request: Request, env: Env, agentId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const agent = await env.DB.prepare(
    "SELECT id, name, status FROM agents WHERE id = ?"
  ).bind(agentId).first<{ id: string; name: string; status: string }>();
  if (!agent) return json({ error: "agent_not_found" }, 404);

  const apiKey = newSecret("lci_");
  const apiKeyHash = await sha256(apiKey);
  const update = await env.DB.prepare(
    "UPDATE agents SET api_key_hash = ? WHERE id = ?"
  ).bind(apiKeyHash, agentId).run();
  if ((update.meta?.changes ?? 0) !== 1) return json({ error: "key_rotation_failed" }, 500);

  return json({
    agent: { id: agent.id, name: agent.name, status: agent.status },
    apiKey,
    warning: "The previous key is invalid immediately. Store this new key securely; it cannot be retrieved later."
  });
}

async function disableAgent(request: Request, env: Env, agentId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const update = await env.DB.prepare(
    "UPDATE agents SET status = 'disabled' WHERE id = ? AND status = 'active'"
  ).bind(agentId).run();
  if ((update.meta?.changes ?? 0) !== 1) return json({ error: "active_agent_not_found" }, 404);
  return json({ agentId, status: "disabled" });
}

async function disableWallet(request: Request, env: Env, walletId: string): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const activeReservations = await env.DB.prepare(`
    SELECT COUNT(*) AS count
    FROM reservations r
    JOIN wallet_balances b ON b.id = r.wallet_balance_id
    WHERE b.wallet_id = ? AND r.status = 'active'
  `).bind(walletId).first<{ count: number }>();
  if ((activeReservations?.count ?? 0) > 0) {
    return json({
      error: "wallet_has_active_reservations",
      activeReservations: activeReservations?.count ?? 0
    }, 409);
  }
  const update = await env.DB.prepare(
    "UPDATE wallets SET status = 'disabled' WHERE id = ? AND status = 'active'"
  ).bind(walletId).run();
  if ((update.meta?.changes ?? 0) !== 1) return json({ error: "active_wallet_not_found" }, 404);
  return json({ walletId, status: "disabled" });
}

async function registerWallet(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const { businessId, agentId, network, address, scope } = body;
  const purpose = body.purpose === undefined ? "operating" : body.purpose;
  if (
    typeof businessId !== "string" ||
    network !== "solana" ||
    typeof address !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ||
    (scope !== "agent" && scope !== "business") ||
    (purpose !== "operating" && purpose !== "api_payment") ||
    (purpose === "api_payment" && scope !== "business") ||
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
      "INSERT INTO wallets (id, business_id, agent_id, network, address, scope, purpose) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(walletId, businessId, scope === "agent" ? agentId : null, network, address, scope, purpose).run();
  } catch {
    return json({ error: "wallet_not_registered", message: "Wallet may already be registered." }, 409);
  }

  return json({ walletId, businessId, agentId: scope === "agent" ? agentId : null, network, address, scope, purpose }, 201);
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

async function solanaRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
  const payload = await response.json() as { result?: T; error?: { message?: string } };
  if (payload.error || payload.result === undefined) throw new Error(payload.error?.message ?? "Solana RPC returned no result");
  return payload.result;
}

async function syncSolanaBalances(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const rpcUrl = env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const usdcMint = env.SOLANA_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const wallets = await env.DB.prepare(
    "SELECT id, address FROM wallets WHERE network = 'solana' AND status = 'active'"
  ).all<{ id: string; address: string }>();

  const synced: Array<{ walletId: string; address: string; usdc: string; sol: string }> = [];
  const errors: Array<{ walletId: string; error: string }> = [];

  for (const wallet of wallets.results ?? []) {
    try {
      const [solResult, tokenResult] = await Promise.all([
        solanaRpc<{ value: number }>(rpcUrl, "getBalance", [wallet.address, { commitment: "confirmed" }]),
        solanaRpc<{ value: Array<{ account: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }> }>(
          rpcUrl,
          "getTokenAccountsByOwner",
          [wallet.address, { mint: usdcMint }, { encoding: "jsonParsed", commitment: "confirmed" }]
        )
      ]);

      const usdcAtoms = tokenResult.value.reduce((sum, account) => {
        const raw = account.account.data.parsed?.info?.tokenAmount?.amount ?? "0";
        return sum + BigInt(raw);
      }, 0n);
      const solLamports = BigInt(solResult.value);
      const balanceId = "bal_" + crypto.randomUUID().replaceAll("-", "");

      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
          VALUES (?, ?, 'USDC', ?, '0', datetime('now'), 'solana_rpc')
          ON CONFLICT(wallet_id, token) DO UPDATE SET
            confirmed_atoms = excluded.confirmed_atoms,
            observed_at = excluded.observed_at,
            source = 'solana_rpc'
        `).bind(balanceId, wallet.id, usdcAtoms.toString()),
        env.DB.prepare(`
          INSERT INTO wallet_balances (id, wallet_id, token, confirmed_atoms, reserved_atoms, observed_at, source)
          VALUES (?, ?, 'SOL', ?, '0', datetime('now'), 'solana_rpc')
          ON CONFLICT(wallet_id, token) DO UPDATE SET
            confirmed_atoms = excluded.confirmed_atoms,
            observed_at = excluded.observed_at,
            source = 'solana_rpc'
        `).bind("bal_" + crypto.randomUUID().replaceAll("-", ""), wallet.id, solLamports.toString())
      ]);

      synced.push({
        walletId: wallet.id,
        address: wallet.address,
        usdc: formatTokenAmount(usdcAtoms, 6),
        sol: formatTokenAmount(solLamports, 9)
      });
    } catch (error) {
      errors.push({
        walletId: wallet.id,
        error: error instanceof Error ? error.message : "Balance sync failed"
      });
    }
  }

  return json({
    source: "solana_rpc",
    commitment: "confirmed",
    synced,
    errors,
    observedAt: new Date().toISOString()
  }, errors.length && !synced.length ? 502 : 200);
}

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type ConversionContext = {
  operationId: string;
  userAddress: string;
  paymentWalletAddress: string;
  sourceAmount: string;
  sourceAtoms: bigint;
  shortfallAtoms: bigint;
  walletBalanceId: string;
  sourceReservationId: string | null;
  buildQuoteId: string | null;
};

async function validateConversionContext(
  agent: AgentRow,
  body: Record<string, unknown>,
  env: Env,
  allowPreparing = false
): Promise<ConversionContext | Response> {
  const { operationId, userAddress, paymentWalletAddress, sourceAmount } = body;
  if (
    typeof operationId !== "string" ||
    typeof userAddress !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(userAddress) ||
    typeof paymentWalletAddress !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(paymentWalletAddress) ||
    typeof sourceAmount !== "string"
  ) {
    return json({ error: "invalid_request", message: "Provide operationId, registered operating userAddress, registered paymentWalletAddress and sourceAmount in SOL." }, 400);
  }

  let sourceAtoms: bigint;
  try {
    sourceAtoms = parseTokenAmount(sourceAmount, 9);
  } catch (error) {
    return json({ error: "invalid_source_amount", message: error instanceof Error ? error.message : "Invalid SOL amount" }, 400);
  }

  const operation = await env.DB.prepare(
    "SELECT id, status, shortfall_atoms, source_reservation_id, source_wallet_id, build_quote_id FROM operations WHERE id = ? AND agent_id = ? AND action = 'conversion_required' LIMIT 1"
  ).bind(operationId, agent.id).first<{
    id: string;
    status: string;
    shortfall_atoms: string;
    source_reservation_id: string | null;
    source_wallet_id: string | null;
    build_quote_id: string | null;
  }>();
  if (!operation) return json({ error: "conversion_operation_not_found" }, 404);

  const isAwaiting = operation.status === "awaiting_conversion";
  const isPreparing = allowPreparing && operation.status === "preparing_conversion";
  if (!isAwaiting && !isPreparing) {
    return json({ error: "operation_not_ready_for_conversion", status: operation.status }, 409);
  }

  if (!operation.source_wallet_id) return json({ error: "conversion_source_wallet_missing" }, 409);

  const wallet = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.address, b.confirmed_atoms, b.reserved_atoms, b.observed_at
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id AND b.token = 'SOL'
    WHERE w.id = ? AND w.business_id = ? AND w.network = 'solana' AND w.address = ? AND w.status = 'active' AND w.purpose = 'operating'
      AND (
        (w.scope = 'agent' AND w.agent_id = ?) OR
        (w.scope = 'business' AND ? = 1)
      )
    LIMIT 1
  `).bind(operation.source_wallet_id, agent.business_id, userAddress, agent.id, agent.can_use_business_treasury).first<{
    wallet_id: string;
    address: string;
    confirmed_atoms: string;
    reserved_atoms: string;
    observed_at: string;
  }>();

  if (!wallet) return json({ error: "source_wallet_not_authorized" }, 403);

  const paymentWallet = await env.DB.prepare(`
    SELECT b.confirmed_atoms, b.reserved_atoms, b.observed_at
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id AND b.token = 'USDC'
    WHERE w.business_id = ? AND w.network = 'solana' AND w.address = ?
      AND w.scope = 'business' AND w.purpose = 'api_payment' AND w.status = 'active'
    LIMIT 1
  `).bind(agent.business_id, paymentWalletAddress).first<{
    confirmed_atoms: string;
    reserved_atoms: string;
    observed_at: string;
  }>();
  if (!paymentWallet) return json({ error: "api_payment_wallet_not_configured" }, 409);
  const paymentAgeMs = Date.now() - Date.parse(paymentWallet.observed_at);
  const paymentAvailable = BigInt(paymentWallet.confirmed_atoms) - BigInt(paymentWallet.reserved_atoms);
  if (!Number.isFinite(paymentAgeMs) || paymentAgeMs < 0 || paymentAgeMs > 5 * 60 * 1000 || paymentAvailable < 10_000n) {
    return json({
      error: "api_payment_reserve_unavailable",
      message: "The dedicated x402 payment wallet needs a fresh balance of at least 0.01 USDC for quote and build calls.",
      minimumReserveUSDC: "0.01"
    }, 409);
  }
  const ageMs = Date.now() - Date.parse(wallet.observed_at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 5 * 60 * 1000) {
    return json({ error: "source_balance_stale", message: "Refresh Solana balances before requesting a conversion." }, 409);
  }

  let ownReservationAtoms = 0n;
  if (isPreparing) {
    if (!operation.source_reservation_id) {
      return json({ error: "source_reservation_missing" }, 409);
    }
    const reservation = await env.DB.prepare(
      "SELECT amount_atoms, wallet_balance_id, token, status FROM reservations WHERE id = ? AND operation_id = ?"
    ).bind(operation.source_reservation_id, operationId).first<{
      amount_atoms: string;
      wallet_balance_id: string;
      token: string;
      status: string;
    }>();
    if (
      !reservation || reservation.status !== "active" || reservation.token !== "SOL" ||
      reservation.wallet_balance_id !== wallet.wallet_id || BigInt(reservation.amount_atoms) !== sourceAtoms
    ) {
      return json({ error: "source_reservation_mismatch" }, 409);
    }
    ownReservationAtoms = sourceAtoms;
  }

  const confirmed = BigInt(wallet.confirmed_atoms);
  const reserved = BigInt(wallet.reserved_atoms);
  const available = confirmed > reserved ? confirmed - reserved : 0n;
  if (available + ownReservationAtoms < sourceAtoms) {
    return json({
      error: "insufficient_source_balance",
      availableSOL: formatTokenAmount(available + ownReservationAtoms, 9),
      requestedSOL: sourceAmount
    }, 409);
  }

  return {
    operationId,
    userAddress,
    paymentWalletAddress,
    sourceAmount,
    sourceAtoms,
    shortfallAtoms: BigInt(operation.shortfall_atoms),
    walletBalanceId: wallet.wallet_id,
    sourceReservationId: operation.source_reservation_id,
    buildQuoteId: operation.build_quote_id
  };
}

async function proxyHermes(
  request: Request,
  path: string,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  const payment = request.headers.get("x-payment");
  const paymentSignature = request.headers.get("payment-signature");
  if (payment) headers.set("X-PAYMENT", payment);
  if (paymentSignature) headers.set("PAYMENT-SIGNATURE", paymentSignature);

  const upstream = await fetch(`https://hermes.swap.io${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const responseHeaders = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store"
  });
  for (const name of ["x-payment-required", "payment-required", "x-payment-response", "payment-response"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) responseHeaders.set(name, value);

  const responseBody = await upstream.arrayBuffer();
  if (upstream.status === 200 && (path === "/v1/swap/quote" || path === "/v1/swap/build-tx")) {
    const receiptHeader = upstream.headers.get("x-payment-response") ?? upstream.headers.get("payment-response");
    let receipt: { success?: boolean } | null = null;
    try {
      if (receiptHeader) receipt = JSON.parse(atob(receiptHeader)) as { success?: boolean };
    } catch {
      receipt = null;
    }
    if (!receipt?.success) {
      return json({
        error: "swap_payment_receipt_missing_or_invalid",
        message: "Hermes returned HTTP 200 without a successful x402 settlement receipt. The response was not accepted."
      }, 502);
    }
  }

  return new Response(responseBody, {
    status: upstream.status,
    headers: responseHeaders
  });
}

async function requestSwapQuote(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const context = await validateConversionContext(agent, body, env);
  if (context instanceof Response) return context;

  const slippageBps = body.slippageBps === undefined ? 50 : body.slippageBps;
  if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 300) {
    return json({ error: "invalid_slippage", message: "slippageBps must be an integer from 1 to 300." }, 400);
  }

  const upstream = await proxyHermes(request, "/v1/swap/quote", {
    input: { token: SOL_MINT, amount: context.sourceAtoms.toString(), chainKey: "sol" },
    output: { token: USDC_MINT, chainKey: "sol" },
    userAddress: context.userAddress,
    slippageBps
  }, {
    "X-Liquidity-Operation-ID": context.operationId,
    "X-Liquidity-Required-USDC": formatTokenAmount(context.shortfallAtoms, 6)
  });

  if (upstream.status !== 200) return upstream;

  let payload: { quotes?: Array<Record<string, unknown>> };
  try {
    payload = await upstream.clone().json() as { quotes?: Array<Record<string, unknown>> };
  } catch {
    return json({ error: "invalid_hermes_quote_response" }, 502);
  }

  const quotes = payload.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) {
    return json({ error: "no_swap_routes", message: "Hermes returned no usable SOL-to-USDC routes." }, 502);
  }
  if (JSON.stringify(quotes).length > 250_000) {
    return json({ error: "quote_payload_too_large" }, 502);
  }

  const quoteId = "qte_" + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  try {
    await env.DB.prepare(`
      INSERT INTO swap_quotes
        (id, operation_id, agent_id, source_wallet_id, user_address,
         source_amount_atoms, required_output_atoms, quotes_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      quoteId,
      context.operationId,
      agent.id,
      context.walletBalanceId,
      context.userAddress,
      context.sourceAtoms.toString(),
      context.shortfallAtoms.toString(),
      JSON.stringify(quotes),
      expiresAt
    ).run();
  } catch {
    return json({ error: "quote_cache_failed" }, 500);
  }

  const summaries = quotes.map((quote, index) => {
    const providerValue = quote.provider as { key?: string } | string | undefined;
    const provider = typeof providerValue === "string" ? providerValue : providerValue?.key ?? null;
    const output = quote.output as { amount?: string; minAmount?: string } | undefined;
    const minOutput = output?.minAmount;
    let minOutputCoversShortfall = false;
    if (typeof minOutput === "string" && /^\d+$/.test(minOutput)) {
      minOutputCoversShortfall = BigInt(minOutput) >= context.shortfallAtoms;
    }
    return {
      index,
      provider,
      outputAmount: output?.amount ?? null,
      minOutputAmount: minOutput ?? null,
      minOutputCoversShortfall,
      priceImpactPct: quote.priceImpactPct ?? null
    };
  });

  return json({
    quoteId,
    expiresAt,
    requiredOutputUSDC: formatTokenAmount(context.shortfallAtoms, 6),
    quotes: summaries,
    note: "Only select a quote whose minimum output covers the required USDC shortfall. The quote is cached server-side and expires in 15 minutes."
  }, 200);
}

async function prepareSwapTransaction(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.quoteId !== "string" || !/^qte_[a-f0-9-]{36}$/i.test(body.quoteId)) {
    return json({ error: "invalid_quote_id" }, 400);
  }

  const quote = await env.DB.prepare(`
    SELECT id, operation_id, agent_id, source_wallet_id, user_address,
           source_amount_atoms, required_output_atoms, quotes_json, expires_at,
           build_response_json, build_payment_receipt
    FROM swap_quotes
    WHERE id = ? AND agent_id = ? AND operation_id = ?
      AND julianday(expires_at) > julianday('now')
    LIMIT 1
  `).bind(body.quoteId, agent.id, body.operationId).first<{
    id: string;
    operation_id: string;
    agent_id: string;
    source_wallet_id: string;
    user_address: string;
    source_amount_atoms: string;
    required_output_atoms: string;
    quotes_json: string;
    expires_at: string;
    build_response_json: string | null;
    build_payment_receipt: string | null;
  }>();
  if (!quote) return json({ error: "quote_not_found_or_expired" }, 404);

  const selectedIndex = body.index === undefined ? 0 : body.index;
  if (typeof selectedIndex !== "number" || !Number.isInteger(selectedIndex) || selectedIndex < 0) {
    return json({ error: "invalid_quote_index" }, 400);
  }

  let quotes: Array<Record<string, unknown>>;
  try {
    quotes = JSON.parse(quote.quotes_json) as Array<Record<string, unknown>>;
  } catch {
    return json({ error: "cached_quote_corrupt" }, 500);
  }
  const selected = quotes[selectedIndex];
  if (!selected) return json({ error: "quote_index_not_found" }, 404);

  const providerValue = selected.provider as { key?: string } | string | undefined;
  const provider = typeof providerValue === "string" ? providerValue : providerValue?.key;
  const providerQuote = selected.providerQuote;
  const output = selected.output as { minAmount?: string } | undefined;
  const minOutput = output?.minAmount;

  if (typeof provider !== "string" || !provider || !providerQuote || typeof providerQuote !== "object" || Array.isArray(providerQuote)) {
    return json({ error: "cached_provider_quote_invalid" }, 409);
  }
  if (typeof minOutput !== "string" || !/^\d+$/.test(minOutput) || BigInt(minOutput) < BigInt(quote.required_output_atoms)) {
    return json({
      error: "quote_below_required_shortfall",
      requiredUSDC: formatTokenAmount(BigInt(quote.required_output_atoms), 6),
      minimumOutputUSDC: typeof minOutput === "string" && /^\d+$/.test(minOutput)
        ? formatTokenAmount(BigInt(minOutput), 6)
        : null
    }, 409);
  }

  const context = await validateConversionContext(agent, {
    operationId: quote.operation_id,
    userAddress: quote.user_address,
    paymentWalletAddress: body.paymentWalletAddress,
    sourceAmount: formatTokenAmount(BigInt(quote.source_amount_atoms), 9)
  }, env, true);
  if (context instanceof Response) return context;
  if (context.walletBalanceId !== quote.source_wallet_id || context.sourceAtoms.toString() !== quote.source_amount_atoms) {
    return json({ error: "quote_context_mismatch" }, 409);
  }
  if (context.buildQuoteId && context.buildQuoteId !== quote.id) {
    return json({ error: "operation_quote_locked", message: "This operation is already preparing a different quote." }, 409);
  }
  if (context.sourceReservationId && context.buildQuoteId !== quote.id) {
    return json({ error: "operation_quote_lock_missing" }, 409);
  }

  if (quote.build_response_json) {
    const cachedHeaders = new Headers({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    if (quote.build_payment_receipt) cachedHeaders.set("X-PAYMENT-RESPONSE", quote.build_payment_receipt);
    return new Response(quote.build_response_json, { status: 200, headers: cachedHeaders });
  }

  if (!context.sourceReservationId) {
    const reservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const reserve = await env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + ?
      WHERE id = ?
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= ?
    `).bind(context.sourceAtoms.toString(), context.walletBalanceId, context.sourceAtoms.toString()).run();

    if ((reserve.meta?.changes ?? 0) !== 1) {
      return json({ error: "source_balance_changed", message: "SOL was allocated elsewhere. Refresh balances and request a new quote." }, 409);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`
          INSERT INTO reservations (id, operation_id, wallet_balance_id, amount_atoms, expires_at, token)
          VALUES (?, ?, ?, ?, ?, 'SOL')
        `).bind(reservationId, context.operationId, context.walletBalanceId, context.sourceAtoms.toString(), expiresAt),
        env.DB.prepare(`
          UPDATE operations
          SET status = 'preparing_conversion', source_reservation_id = ?, provider_key = ?, build_quote_id = ?
          WHERE id = ? AND status = 'awaiting_conversion' AND build_quote_id IS NULL
        `).bind(reservationId, provider, quote.id, context.operationId)
      ]);
      const refreshed = await env.DB.prepare(
        "SELECT source_reservation_id, build_quote_id FROM operations WHERE id = ? AND status = 'preparing_conversion'"
      ).bind(context.operationId).first<{ source_reservation_id: string | null; build_quote_id: string | null }>();
      if (refreshed?.source_reservation_id !== reservationId || refreshed.build_quote_id !== quote.id) {
        throw new Error("Operation was claimed by another prepare request");
      }
    } catch {
      await env.DB.prepare(
        "UPDATE operations SET status = 'awaiting_conversion', source_reservation_id = NULL, provider_key = NULL, build_quote_id = NULL WHERE id = ? AND status = 'preparing_conversion' AND source_reservation_id = ?"
      ).bind(context.operationId, reservationId).run();
      await env.DB.prepare(
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?"
      ).bind(context.sourceAtoms.toString(), context.walletBalanceId, context.sourceAtoms.toString()).run();
      await env.DB.prepare("DELETE FROM reservations WHERE id = ? AND status = 'active'").bind(reservationId).run();
      return json({ error: "source_reservation_failed" }, 409);
    }
  }

  const upstream = await proxyHermes(request, "/v1/swap/build-tx", {
    provider,
    userAddress: context.userAddress,
    chainKey: "sol",
    quoteResponse: providerQuote
  }, {
    "X-Liquidity-Operation-ID": context.operationId,
    "X-Liquidity-Required-USDC": formatTokenAmount(context.shortfallAtoms, 6),
    "X-Liquidity-Source-Reserved-SOL": context.sourceAmount
  });

  if (upstream.status !== 200) return upstream;

  let buildPayload: Record<string, unknown>;
  try {
    buildPayload = await upstream.clone().json() as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_hermes_build_response" }, 502);
  }
  const transaction = buildPayload.transaction ?? buildPayload.swapTransaction ?? buildPayload.tx;
  if (typeof transaction !== "string" || transaction.length < 20) {
    return json({ error: "unsigned_transaction_missing" }, 502);
  }

  const receipt = upstream.headers.get("x-payment-response") ?? upstream.headers.get("payment-response");
  const cached = await env.DB.prepare(
    "UPDATE swap_quotes SET build_response_json = ?, build_payment_receipt = ?, built_at = datetime('now') WHERE id = ? AND agent_id = ? AND build_response_json IS NULL"
  ).bind(JSON.stringify(buildPayload), receipt, quote.id, agent.id).run();
  if ((cached.meta?.changes ?? 0) !== 1) {
    const saved = await env.DB.prepare(
      "SELECT build_response_json, build_payment_receipt FROM swap_quotes WHERE id = ? AND agent_id = ?"
    ).bind(quote.id, agent.id).first<{ build_response_json: string | null; build_payment_receipt: string | null }>();
    if (!saved?.build_response_json) return json({ error: "build_cache_failed" }, 500);
    const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    if (saved.build_payment_receipt) headers.set("X-PAYMENT-RESPONSE", saved.build_payment_receipt);
    return new Response(saved.build_response_json, { status: 200, headers });
  }

  return upstream;
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
    WHERE w.business_id = ? AND w.network = 'solana' AND w.status = 'active' AND w.purpose = 'operating'
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

    const futureImpact = await safeBusinessForecast(agent, env);
    await notifyBusiness(
      env,
      agent.business_id,
      `Liquidity reserved: ${formatTokenAmount(requestedAtoms)} USDC for task ${taskId}. Operation ${operationId} expires in 15 minutes unless released or completed.`
    );

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
      futureImpact,
      note: "Funds are reserved in the internal ledger, not transferred. A separate approved execution step is still required. Future impact is a business-wide forecast, not a reservation."
    }, 201);
  }

  const status = decision.action === "conversion_required" ? "awaiting_conversion" : "blocked";
  let targetReservationId: string | null = null;
  let targetBalanceId: string | null = null;
  let targetReservedAtoms = 0n;

  if (decision.action === "conversion_required" && decision.availableAtoms > 0n && decision.sourceWalletId) {
    const targetBalance = eligibleRows.find((row) =>
      row.wallet_id === decision.sourceWalletId && row.token === "USDC"
    );
    if (!targetBalance) return json({ error: "target_balance_changed" }, 409);

    targetReservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
    targetBalanceId = targetBalance.balance_id;
    targetReservedAtoms = decision.availableAtoms;
    const reserveTarget = await env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + ?
      WHERE id = ?
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= ?
    `).bind(targetReservedAtoms.toString(), targetBalanceId, targetReservedAtoms.toString()).run();

    if ((reserveTarget.meta?.changes ?? 0) !== 1) {
      return json({ error: "target_balance_changed", message: "Existing USDC was allocated by another operation. Refresh and retry." }, 409);
    }
  }

  try {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO operations
          (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose,
           status, action, available_atoms, shortfall_atoms, source_wallet_id, target_reservation_id)
        VALUES (?, ?, ?, ?, 'solana', 'USDC', ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        operationId, agent.business_id, agent.id, taskId, requestedAtoms.toString(),
        purpose.trim(), status, decision.action, decision.availableAtoms.toString(),
        decision.shortfallAtoms.toString(), decision.sourceWalletId, targetReservationId
      ),
      ...(targetReservationId && targetBalanceId ? [
        env.DB.prepare(`
          INSERT INTO reservations (id, operation_id, wallet_balance_id, amount_atoms, expires_at, token)
          VALUES (?, ?, ?, ?, ?, 'USDC')
        `).bind(
          targetReservationId,
          operationId,
          targetBalanceId,
          targetReservedAtoms.toString(),
          expiresAt
        )
      ] : [])
    ]);
  } catch {
    if (targetReservationId && targetBalanceId && targetReservedAtoms > 0n) {
      await env.DB.prepare(
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?"
      ).bind(targetReservedAtoms.toString(), targetBalanceId, targetReservedAtoms.toString()).run();
    }
    return json({ error: "operation_not_created" }, 409);
  }

  const futureImpact = await safeBusinessForecast(agent, env);
  await notifyBusiness(
    env,
    agent.business_id,
    decision.action === "conversion_required"
      ? `Liquidity shortfall: task ${taskId} needs ${formatTokenAmount(decision.shortfallAtoms)} additional USDC. ${targetReservedAtoms > 0n ? formatTokenAmount(targetReservedAtoms) + " USDC is reserved in the selected source wallet." : ""} Eligible source assets: ${decision.eligibleSourceTokens.join(", ") || "none"}. Operation ${operationId}.`
      : `Liquidity blocked: task ${taskId} has insufficient authorized funds. Operation ${operationId}.`
  );

  return json({
    operationId,
    status,
    requested: { network: "solana", token: "USDC", amount: formatTokenAmount(requestedAtoms) },
    liquidity: {
      available: formatTokenAmount(decision.availableAtoms),
      reservedTargetUSDC: formatTokenAmount(targetReservedAtoms),
      shortfall: formatTokenAmount(decision.shortfallAtoms)
    },
    action: decision.action,
    eligibleSourceTokens: decision.eligibleSourceTokens,
    sourceWalletId: decision.sourceWalletId,
    targetReservationId,
    futureImpact,
    note: "No conversion, signing or transfer has occurred. Existing target USDC is held separately from the SOL source reservation."
  }, 201);
}

async function releaseOperation(request: Request, env: Env, operationId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const operation = await env.DB.prepare(
    "SELECT id, status FROM operations WHERE id = ? AND agent_id = ?"
  ).bind(operationId, agent.id).first<{ id: string; status: string }>();
  if (!operation) return json({ error: "operation_not_found" }, 404);

  const releasable = [
    "reserved",
    "awaiting_conversion",
    "preparing_conversion",
    "conversion_settled",
    "conversion_settled_shortfall",
    "conversion_unverified"
  ];
  if (!releasable.includes(operation.status)) {
    return json({ error: "operation_not_releasable", status: operation.status }, 409);
  }

  const operationClaim = await env.DB.prepare(
    "UPDATE operations SET status = 'released' WHERE id = ? AND agent_id = ? AND status = ?"
  ).bind(operationId, agent.id, operation.status).run();
  if ((operationClaim.meta?.changes ?? 0) !== 1) {
    return json({ error: "operation_state_changed" }, 409);
  }

  const reservations = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms, token FROM reservations WHERE operation_id = ? AND status = 'active'"
  ).bind(operationId).all<{
    id: string;
    wallet_balance_id: string;
    amount_atoms: string;
    token: string;
  }>();

  const processed: Array<{ id: string; wallet_balance_id: string; amount_atoms: string; token: string; debited: boolean }> = [];
  for (const reservation of reservations.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).bind(reservation.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    const debit = await env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?
      WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?
    `).bind(reservation.amount_atoms, reservation.wallet_balance_id, reservation.amount_atoms).run();

    if ((debit.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare(
        "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'released'"
      ).bind(reservation.id).run();

      for (const item of processed) {
        if (item.debited) {
          await env.DB.prepare(
            "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + ? WHERE id = ?"
          ).bind(item.amount_atoms, item.wallet_balance_id).run();
        }
        await env.DB.prepare(
          "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'released'"
        ).bind(item.id).run();
      }
      await env.DB.prepare(
        "UPDATE operations SET status = ? WHERE id = ? AND status = 'released'"
      ).bind(operation.status, operationId).run();
      return json({ error: "reservation_ledger_mismatch", message: "No reservations were released." }, 409);
    }

    processed.push({ ...reservation, debited: true });
  }

  const released = processed.map((item) => ({
    amount: formatTokenAmount(BigInt(item.amount_atoms), item.token === "SOL" ? 9 : 6),
    token: item.token
  }));

  await notifyBusiness(
    env,
    agent.business_id,
    `Operation ${operationId} released. ${released.map((item) => item.amount + " " + item.token).join(", ") || "No funds were reserved"} returned to available liquidity.`
  );

  return json({ operationId, status: "released", released });
}

async function completeOperation(request: Request, env: Env, operationId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const operation = await env.DB.prepare(
    "SELECT id, status FROM operations WHERE id = ? AND agent_id = ?"
  ).bind(operationId, agent.id).first<{ id: string; status: string }>();
  if (!operation) return json({ error: "operation_not_found" }, 404);
  if (operation.status !== "reserved" && operation.status !== "conversion_settled") {
    return json({ error: "operation_not_completable", status: operation.status }, 409);
  }

  const claimOperation = await env.DB.prepare(
    "UPDATE operations SET status = 'completed' WHERE id = ? AND agent_id = ? AND status = ?"
  ).bind(operationId, agent.id, operation.status).run();
  if ((claimOperation.meta?.changes ?? 0) !== 1) return json({ error: "operation_state_changed" }, 409);

  const reservations = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms, token FROM reservations WHERE operation_id = ? AND status = 'active'"
  ).bind(operationId).all<{
    id: string;
    wallet_balance_id: string;
    amount_atoms: string;
    token: string;
  }>();

  const processed: Array<{ id: string; wallet_balance_id: string; amount_atoms: string }> = [];
  for (const reservation of reservations.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE reservations SET status = 'consumed', released_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).bind(reservation.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    const debit = await env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?, observed_at = datetime('now', '-10 minutes')
      WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?
    `).bind(reservation.amount_atoms, reservation.wallet_balance_id, reservation.amount_atoms).run();

    if ((debit.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare(
        "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'consumed'"
      ).bind(reservation.id).run();
      for (const item of processed) {
        await env.DB.prepare(
          "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + ?, observed_at = datetime('now', '-10 minutes') WHERE id = ?"
        ).bind(item.amount_atoms, item.wallet_balance_id).run();
        await env.DB.prepare(
          "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'consumed'"
        ).bind(item.id).run();
      }
      await env.DB.prepare(
        "UPDATE operations SET status = ? WHERE id = ? AND status = 'completed'"
      ).bind(operation.status, operationId).run();
      return json({ error: "reservation_ledger_mismatch" }, 409);
    }
    processed.push({ id: reservation.id, wallet_balance_id: reservation.wallet_balance_id, amount_atoms: reservation.amount_atoms });
  }

  await notifyBusiness(
    env,
    agent.business_id,
    `Agent reported operation ${operationId} completed. Internal reservations were consumed and wallet snapshots marked stale pending on-chain refresh.`
  );

  return json({
    operationId,
    status: "completed",
    reservationsConsumed: processed.length,
    note: "Completion is agent-reported. This endpoint does not prove that an external payment or task action occurred."
  });
}

async function expireReservations(env: Env): Promise<{ expired: number; skipped: number }> {
  const dueOperations = await env.DB.prepare(`
    SELECT DISTINCT o.id, o.business_id, o.status
    FROM operations o
    JOIN reservations r ON r.operation_id = o.id
    WHERE r.status = 'active'
      AND julianday(r.expires_at) <= julianday('now')
      AND o.status IN (
        'reserved', 'awaiting_conversion', 'preparing_conversion',
        'conversion_submitted', 'conversion_settled', 'conversion_settled_shortfall', 'conversion_unverified'
      )
    ORDER BY o.created_at ASC
    LIMIT 100
  `).all<{ id: string; business_id: string; status: string }>();

  let expired = 0;
  let skipped = 0;
  for (const operation of dueOperations.results ?? []) {
    const claimOperation = await env.DB.prepare(`
      UPDATE operations SET status = 'expired'
      WHERE id = ? AND status = ?
        AND EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.operation_id = operations.id
            AND r.status = 'active'
            AND julianday(r.expires_at) <= julianday('now')
        )
    `).bind(operation.id, operation.status).run();

    if ((claimOperation.meta?.changes ?? 0) !== 1) {
      skipped++;
      continue;
    }

    const reservations = await env.DB.prepare(
      "SELECT id, wallet_balance_id, amount_atoms FROM reservations WHERE operation_id = ? AND status = 'active'"
    ).bind(operation.id).all<{
      id: string;
      wallet_balance_id: string;
      amount_atoms: string;
    }>();

    const processed: Array<{ id: string; wallet_balance_id: string; amount_atoms: string; debited: boolean }> = [];
    let failed = false;
    for (const reservation of reservations.results ?? []) {
      const claim = await env.DB.prepare(
        "UPDATE reservations SET status = 'expired', released_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).bind(reservation.id).run();
      if ((claim.meta?.changes ?? 0) !== 1) continue;

      const debit = await env.DB.prepare(`
        UPDATE wallet_balances
        SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?
        WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?
      `).bind(reservation.amount_atoms, reservation.wallet_balance_id, reservation.amount_atoms).run();

      if ((debit.meta?.changes ?? 0) !== 1) {
        await env.DB.prepare(
          "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'expired'"
        ).bind(reservation.id).run();
        failed = true;
        break;
      }
      processed.push({ ...reservation, debited: true });
    }

    if (failed) {
      for (const item of processed) {
        await env.DB.prepare(
          "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + ? WHERE id = ?"
        ).bind(item.amount_atoms, item.wallet_balance_id).run();
        await env.DB.prepare(
          "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'expired'"
        ).bind(item.id).run();
      }
      await env.DB.prepare(
        "UPDATE operations SET status = ? WHERE id = ? AND status = 'expired'"
      ).bind(operation.status, operation.id).run();
      skipped++;
      continue;
    }

    await notifyBusiness(
      env,
      operation.business_id,
      `Reservation expired for operation ${operation.id}. All active internal holds were released back to available liquidity.`
    );
    expired++;
  }
  return { expired, skipped };
}

async function expireReservationsAdmin(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const result = await expireReservations(env);
  return json({ ...result, message: "Expired reservations were released from the internal ledger." });
}

async function trackSwapTransaction(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const { operationId, transactionHash } = body;
  if (
    typeof operationId !== "string" ||
    typeof transactionHash !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(transactionHash)
  ) {
    return json({ error: "invalid_request", message: "Provide operationId and a valid Solana transaction signature." }, 400);
  }

  const operation = await env.DB.prepare(
    "SELECT id, status, source_reservation_id FROM operations WHERE id = ? AND agent_id = ?"
  ).bind(operationId, agent.id).first<{ id: string; status: string; source_reservation_id: string | null }>();
  if (!operation) return json({ error: "operation_not_found" }, 404);
  if (operation.status !== "preparing_conversion" || !operation.source_reservation_id) {
    return json({ error: "operation_not_ready_to_track", status: operation.status }, 409);
  }

  const reservation = await env.DB.prepare(
    "SELECT id FROM reservations WHERE id = ? AND status = 'active'"
  ).bind(operation.source_reservation_id).first<{ id: string }>();
  if (!reservation) return json({ error: "active_source_reservation_not_found" }, 409);

  const update = await env.DB.prepare(
    "UPDATE operations SET status = 'conversion_submitted', transaction_hash = ? WHERE id = ? AND status = 'preparing_conversion' AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = operations.source_reservation_id AND r.status = 'active')"
  ).bind(transactionHash, operationId).run();
  if ((update.meta?.changes ?? 0) !== 1) return json({ error: "operation_state_changed" }, 409);

  await env.DB.prepare(
    "UPDATE reservations SET expires_at = datetime('now', '+1 hour') WHERE operation_id = ? AND status = 'active'"
  ).bind(operationId).run();

  await notifyBusiness(
    env,
    agent.business_id,
    `Swap transaction submitted for operation ${operationId}. Awaiting final confirmation.`
  );

  return json({
    operationId,
    status: "conversion_submitted",
    transactionHash,
    message: "Transaction recorded. Poll the operation status until finalized or failed."
  }, 202);
}

async function getSwapStatus(request: Request, env: Env, operationId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const operation = await env.DB.prepare(
    "SELECT id, status, transaction_hash, source_reservation_id, target_reservation_id, shortfall_atoms, received_output_atoms, settlement_note FROM operations WHERE id = ? AND agent_id = ?"
  ).bind(operationId, agent.id).first<{
    id: string;
    status: string;
    transaction_hash: string | null;
    source_reservation_id: string | null;
    target_reservation_id: string | null;
    shortfall_atoms: string;
    received_output_atoms: string | null;
    settlement_note: string | null;
  }>();
  if (!operation) return json({ error: "operation_not_found" }, 404);
  if (["conversion_settled", "conversion_settled_shortfall", "conversion_unverified", "conversion_failed"].includes(operation.status)) {
    return json({
      operationId,
      status: operation.status,
      transactionHash: operation.transaction_hash,
      receivedUSDC: operation.received_output_atoms
        ? formatTokenAmount(BigInt(operation.received_output_atoms), 6)
        : null,
      settlementNote: operation.settlement_note
    });
  }
  if (operation.status !== "conversion_submitted" || !operation.transaction_hash || !operation.source_reservation_id) {
    return json({ error: "transaction_not_submitted", status: operation.status }, 409);
  }

  type SignatureStatus = {
    err: unknown | null;
    confirmationStatus: string | null;
    slot: number;
  };
  let signatureStatus: SignatureStatus | null;
  try {
    const statusResult = await solanaRpc<{ value: Array<SignatureStatus | null> }>(
      env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "getSignatureStatuses",
      [[operation.transaction_hash], { searchTransactionHistory: true }]
    );
    signatureStatus = statusResult.value[0] ?? null;
  } catch {
    return json({ error: "solana_status_unavailable" }, 502);
  }

  if (!signatureStatus) {
    return json({
      operationId,
      transactionHash: operation.transaction_hash,
      swapStatus: "pending",
      operationStatus: operation.status
    });
  }

  const swapStatus = signatureStatus.err
    ? "failed"
    : signatureStatus.confirmationStatus === "finalized"
      ? "finalized"
      : "pending";


  if (swapStatus !== "finalized" && swapStatus !== "failed") {
    return json({ operationId, transactionHash: operation.transaction_hash, swapStatus, operationStatus: operation.status });
  }

  const reservation = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms, token, status FROM reservations WHERE id = ?"
  ).bind(operation.source_reservation_id).first<{
    id: string;
    wallet_balance_id: string;
    amount_atoms: string;
    token: string;
    status: string;
  }>();
  if (!reservation) return json({ error: "source_reservation_not_found" }, 409);

  let effectiveStatus: "finalized" | "failed" | "unverified" | "shortfall" = swapStatus;
  let outputAtoms = 0n;
  let settlementNote: string | null = null;

  if (swapStatus === "finalized") {
    const wallet = await env.DB.prepare(
      "SELECT w.address, b.wallet_id FROM wallet_balances b JOIN wallets w ON w.id = b.wallet_id WHERE b.id = ?"
    ).bind(reservation.wallet_balance_id).first<{ address: string; wallet_id: string }>();
    if (!wallet) return json({ error: "source_wallet_not_found" }, 409);

    type ParsedTokenBalance = {
      owner?: string;
      mint?: string;
      uiTokenAmount?: { amount?: string };
    };
    type TransactionResult = {
      transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string; signer?: boolean }> } };
      meta?: {
        err?: unknown;
        fee?: number;
        preBalances?: number[];
        postBalances?: number[];
        preTokenBalances?: ParsedTokenBalance[];
        postTokenBalances?: ParsedTokenBalance[];
      };
    };

    let transaction: TransactionResult | null;
    try {
      transaction = await solanaRpc<TransactionResult | null>(
        env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
        "getTransaction",
        [operation.transaction_hash, {
          commitment: "finalized",
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0
        }]
      );
    } catch {
      return json({ error: "transaction_verification_unavailable" }, 502);
    }
    if (!transaction?.meta) {
      return json({ operationId, status: "verification_pending", message: "Finalized transaction details are not available from the RPC yet." }, 202);
    }

    if (transaction.meta.err) {
      effectiveStatus = "failed";
      settlementNote = "Solana transaction metadata reports an execution error.";
    } else {
      const keys = transaction.transaction?.message?.accountKeys ?? [];
      const sourceAccount = keys.find((entry) =>
        (typeof entry === "string" ? entry : entry.pubkey) === wallet.address
      );
      const sourceWalletSigned = typeof sourceAccount === "object" && sourceAccount !== null && sourceAccount.signer === true;

      const sumOwnerUsdc = (entries: ParsedTokenBalance[] | undefined) =>
        (entries ?? []).filter((entry) => entry.owner === wallet.address && entry.mint === USDC_MINT)
          .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount?.amount ?? "0"), 0n);

      const beforeUsdc = sumOwnerUsdc(transaction.meta.preTokenBalances);
      const afterUsdc = sumOwnerUsdc(transaction.meta.postTokenBalances);
      outputAtoms = afterUsdc > beforeUsdc ? afterUsdc - beforeUsdc : 0n;

      if (!sourceWalletSigned || outputAtoms === 0n) {
        effectiveStatus = "unverified";
        settlementNote = "The finalized transaction did not show the registered operating wallet as a signer receiving USDC.";
      } else if (outputAtoms < BigInt(operation.shortfall_atoms)) {
        effectiveStatus = "shortfall";
        settlementNote = "The swap finalized, but received USDC is below the operation's required shortfall.";
      }
    }
  }

  const finalReservationState = effectiveStatus === "failed" ? "released" : "consumed";
  if (reservation.status === "active") {
    const claim = await env.DB.prepare(
      "UPDATE reservations SET status = ?, released_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).bind(finalReservationState, reservation.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) return json({ error: "reservation_already_reconciled" }, 409);

    const amount = BigInt(reservation.amount_atoms);
    const debit = await env.DB.prepare(
      "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?"
    ).bind(amount.toString(), reservation.wallet_balance_id, amount.toString()).run();

    if ((debit.meta?.changes ?? 0) !== 1) {
      await env.DB.prepare(
        "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = ?"
      ).bind(reservation.id, finalReservationState).run();
      return json({ error: "reservation_ledger_mismatch" }, 409);
    }
  } else if (reservation.status !== finalReservationState) {
    return json({ error: "source_reservation_already_reconciled", reservationStatus: reservation.status }, 409);
  }

  const walletId = await env.DB.prepare(
    "SELECT wallet_id FROM wallet_balances WHERE id = ?"
  ).bind(reservation.wallet_balance_id).first<{ wallet_id: string }>();
  if (walletId) {
    await env.DB.prepare(
      "UPDATE wallet_balances SET observed_at = datetime('now', '-10 minutes') WHERE wallet_id = ?"
    ).bind(walletId.wallet_id).run();
  }

  const nextStatus = effectiveStatus === "failed"
    ? "conversion_failed"
    : effectiveStatus === "shortfall"
      ? "conversion_settled_shortfall"
      : effectiveStatus === "unverified"
        ? "conversion_unverified"
        : "conversion_settled";

  if (operation.target_reservation_id) {
    const targetReservation = await env.DB.prepare(
      "SELECT id, wallet_balance_id, amount_atoms, status FROM reservations WHERE id = ?"
    ).bind(operation.target_reservation_id).first<{
      id: string;
      wallet_balance_id: string;
      amount_atoms: string;
      status: string;
    }>();

    if (targetReservation?.status === "active" && effectiveStatus === "failed") {
      const claimTarget = await env.DB.prepare(
        "UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).bind(targetReservation.id).run();
      if ((claimTarget.meta?.changes ?? 0) === 1) {
        const debitTarget = await env.DB.prepare(
          "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?"
        ).bind(targetReservation.amount_atoms, targetReservation.wallet_balance_id, targetReservation.amount_atoms).run();
        if ((debitTarget.meta?.changes ?? 0) !== 1) {
          await env.DB.prepare(
            "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'released'"
          ).bind(targetReservation.id).run();
          return json({ error: "target_reservation_ledger_mismatch" }, 409);
        }
      }
    } else if (targetReservation?.status === "active") {
      await env.DB.prepare(
        "UPDATE reservations SET expires_at = datetime('now', '+15 minutes') WHERE id = ? AND status = 'active'"
      ).bind(targetReservation.id).run();
    }
  }

  const finalUpdate = await env.DB.prepare(
    "UPDATE operations SET status = ?, received_output_atoms = ?, settlement_note = ? WHERE id = ? AND status = 'conversion_submitted'"
  ).bind(nextStatus, outputAtoms.toString(), settlementNote, operationId).run();

  if ((finalUpdate.meta?.changes ?? 0) === 1) {
    await notifyBusiness(
      env,
      agent.business_id,
      `Conversion update for ${operationId}: ${nextStatus}. ${outputAtoms > 0n ? formatTokenAmount(outputAtoms, 6) + " USDC received." : ""}`
    );
  }

  return json({
    operationId,
    transactionHash: operation.transaction_hash,
    swapStatus,
    operationStatus: nextStatus,
    receivedUSDC: outputAtoms > 0n ? formatTokenAmount(outputAtoms, 6) : null,
    requiredUSDC: formatTokenAmount(BigInt(operation.shortfall_atoms), 6),
    settlementNote,
    balanceRefreshRequired: true
  });
}

type ForecastWallet = {
  walletId: string;
  address: string;
  scope: string;
  agentId: string | null;
  usdc: bigint;
  sol: bigint;
  usdcFresh: boolean;
  solFresh: boolean;
};

async function buildLiquidityForecast(agent: AgentRow, env: Env): Promise<Record<string, unknown>> {
  const balanceRows = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.address, w.scope, w.agent_id, b.token,
           b.confirmed_atoms, b.reserved_atoms, b.observed_at
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id
    WHERE w.business_id = ? AND w.status = 'active' AND w.purpose = 'operating'
      AND w.network = 'solana'
  `).bind(agent.business_id).all<{
    wallet_id: string;
    address: string;
    scope: string;
    agent_id: string | null;
    token: string;
    confirmed_atoms: string;
    reserved_atoms: string;
    observed_at: string;
  }>();

  const wallets = new Map<string, ForecastWallet>();
  for (const row of balanceRows.results ?? []) {
    if (!wallets.has(row.wallet_id)) {
      wallets.set(row.wallet_id, {
        walletId: row.wallet_id,
        address: row.address,
        scope: row.scope,
        agentId: row.agent_id,
        usdc: 0n,
        sol: 0n,
        usdcFresh: false,
        solFresh: false
      });
    }
    const wallet = wallets.get(row.wallet_id)!;
    const ageMs = Date.now() - Date.parse(row.observed_at);
    const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60 * 1000;
    const confirmed = BigInt(row.confirmed_atoms);
    const reserved = BigInt(row.reserved_atoms);
    const available = confirmed > reserved ? confirmed - reserved : 0n;
    if (row.token === "USDC") {
      wallet.usdc = fresh ? available : 0n;
      wallet.usdcFresh = fresh;
    } else if (row.token === "SOL") {
      wallet.sol = fresh ? available : 0n;
      wallet.solFresh = fresh;
    }
  }

  const obligations = await env.DB.prepare(`
    SELECT o.agent_id, o.task_id, o.amount_atoms, o.due_at, o.purpose,
           a.can_use_business_treasury
    FROM liquidity_obligations o
    JOIN agents a ON a.id = o.agent_id
    WHERE o.business_id = ? AND o.status = 'planned'
      AND a.status = 'active'
      AND julianday(o.due_at) > julianday('now')
      AND julianday(o.due_at) <= julianday('now', '+30 days')
    ORDER BY o.due_at ASC
    LIMIT 200
  `).bind(agent.business_id).all<{
    agent_id: string;
    task_id: string;
    amount_atoms: string;
    due_at: string;
    purpose: string;
    can_use_business_treasury: number;
  }>();

  const remaining = new Map([...wallets.values()].map((wallet) => [wallet.walletId, wallet.usdc]));
  const conversionUsedWallets = new Set<string>();
  const pendingConversions = await env.DB.prepare(
    "SELECT source_wallet_id FROM operations WHERE business_id = ? AND action = 'conversion_required' AND status IN ('awaiting_conversion', 'preparing_conversion', 'conversion_submitted')"
  ).bind(agent.business_id).all<{ source_wallet_id: string | null }>();
  for (const pending of pendingConversions.results ?? []) {
    if (pending.source_wallet_id) conversionUsedWallets.add(pending.source_wallet_id);
  }

  const allForecast = (obligations.results ?? []).map((obligation) => {
    const amount = BigInt(obligation.amount_atoms);
    const eligibleWallets = [...wallets.values()].filter((wallet) =>
      (wallet.scope === "agent" && wallet.agentId === obligation.agent_id) ||
      (wallet.scope === "business" && obligation.can_use_business_treasury === 1)
    );

    const coveredWallet = eligibleWallets
      .filter((wallet) => (remaining.get(wallet.walletId) ?? 0n) >= amount)
      .sort((a, b) => {
        const aRemain = remaining.get(a.walletId) ?? 0n;
        const bRemain = remaining.get(b.walletId) ?? 0n;
        return aRemain < bRemain ? -1 : aRemain > bRemain ? 1 : 0;
      })[0];

    if (coveredWallet) {
      const available = remaining.get(coveredWallet.walletId) ?? 0n;
      remaining.set(coveredWallet.walletId, available - amount);
      return {
        agentId: obligation.agent_id,
        taskId: obligation.task_id,
        dueAt: obligation.due_at,
        purpose: obligation.purpose,
        amountUSDC: formatTokenAmount(amount, 6),
        availableUSDC: formatTokenAmount(available, 6),
        shortfallUSDC: "0",
        status: "covered",
        sourceWalletId: coveredWallet.walletId,
        sourceAsset: null
      };
    }

    const conversionWallet = eligibleWallets
      .filter((wallet) => wallet.sol > 0n && wallet.solFresh && !conversionUsedWallets.has(wallet.walletId))
      .sort((a, b) => {
        const aRemain = remaining.get(a.walletId) ?? 0n;
        const bRemain = remaining.get(b.walletId) ?? 0n;
        return aRemain > bRemain ? -1 : aRemain < bRemain ? 1 : 0;
      })[0];

    if (conversionWallet) {
      conversionUsedWallets.add(conversionWallet.walletId);
      const available = remaining.get(conversionWallet.walletId) ?? 0n;
      const allocated = available < amount ? available : amount;
      remaining.set(conversionWallet.walletId, available - allocated);
      return {
        agentId: obligation.agent_id,
        taskId: obligation.task_id,
        dueAt: obligation.due_at,
        purpose: obligation.purpose,
        amountUSDC: formatTokenAmount(amount, 6),
        availableUSDC: formatTokenAmount(available, 6),
        shortfallUSDC: formatTokenAmount(amount - allocated, 6),
        status: "conversion_required",
        sourceWalletId: conversionWallet.walletId,
        sourceAsset: "SOL",
        sourceSOLAvailable: formatTokenAmount(conversionWallet.sol, 9),
        quoteRequired: true
      };
    }

    const bestWallet = eligibleWallets.sort((a, b) => {
      const aRemain = remaining.get(a.walletId) ?? 0n;
      const bRemain = remaining.get(b.walletId) ?? 0n;
      return aRemain > bRemain ? -1 : aRemain < bRemain ? 1 : 0;
    })[0];
    const available = bestWallet ? remaining.get(bestWallet.walletId) ?? 0n : 0n;
    const allocated = available < amount ? available : amount;
    if (bestWallet && allocated > 0n) remaining.set(bestWallet.walletId, available - allocated);
    return {
      agentId: obligation.agent_id,
      taskId: obligation.task_id,
      dueAt: obligation.due_at,
      purpose: obligation.purpose,
      amountUSDC: formatTokenAmount(amount, 6),
      availableUSDC: formatTokenAmount(available, 6),
      shortfallUSDC: formatTokenAmount(amount - allocated, 6),
      status: "blocked",
      sourceWalletId: bestWallet?.walletId ?? null,
      sourceAsset: null
    };
  });

  const summarize = (items: typeof allForecast) => items.reduce((acc, item) => {
    if (item.status === "covered") acc.covered++;
    else if (item.status === "conversion_required") acc.conversionRequired++;
    else acc.blocked++;
    const shortfall = item.shortfallUSDC;
    if (shortfall !== "0") acc.totalShortfallAtoms += parseTokenAmount(shortfall);
    return acc;
  }, { covered: 0, conversionRequired: 0, blocked: 0, totalShortfallAtoms: 0n });

  const ownForecast = allForecast.filter((item) => item.agentId === agent.id);
  const ownSummary = summarize(ownForecast);
  const businessSummary = summarize(allForecast);
  const relevantWallets = [...wallets.values()].filter((wallet) =>
    (wallet.scope === "agent" && wallet.agentId === agent.id) ||
    (wallet.scope === "business" && agent.can_use_business_treasury === 1)
  );
  const balanceDataFresh = relevantWallets.length > 0 &&
    relevantWallets.every((wallet) => wallet.usdcFresh && wallet.solFresh);
  const businessBalanceDataFresh = wallets.size > 0 &&
    [...wallets.values()].every((wallet) => wallet.usdcFresh && wallet.solFresh);

  const toSummary = (summary: ReturnType<typeof summarize>) => ({
    planned: summary.covered + summary.conversionRequired + summary.blocked,
    covered: summary.covered,
    conversionRequired: summary.conversionRequired,
    blocked: summary.blocked,
    totalShortfallUSDC: formatTokenAmount(summary.totalShortfallAtoms, 6)
  });

  return {
    windowDays: 30,
    balanceDataFresh,
    businessBalanceDataFresh,
    walletsObserved: relevantWallets.length,
    obligations: ownForecast.map(({ agentId: _agentId, ...item }) => item),
    summary: toSummary(ownSummary),
    businessSummary: {
      ...toSummary(businessSummary),
      otherAgentObligations: allForecast.filter((item) => item.agentId !== agent.id).length
    },
    note: "Business-wide forecast allocates shared business wallets across all agents in due-date order. Private wallets remain agent-isolated. Conversion availability is indicative until a live Swap.io quote is obtained; no future funds are reserved."
  };
}

async function safeBusinessForecast(agent: AgentRow, env: Env): Promise<unknown | null> {
  try {
    const forecast = await buildLiquidityForecast(agent, env);
    return forecast.businessSummary ?? null;
  } catch {
    return null;
  }
}

async function upsertLiquidityForecast(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || !Array.isArray(body.obligations) || body.obligations.length < 1 || body.obligations.length > 50) {
    return json({ error: "invalid_request", message: "Provide between 1 and 50 planned obligations." }, 400);
  }

  const statements: D1PreparedStatement[] = [];
  for (const raw of body.obligations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return json({ error: "invalid_obligation" }, 400);
    const obligation = raw as Record<string, unknown>;
    if (
      typeof obligation.taskId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(obligation.taskId) ||
      typeof obligation.dueAt !== "string" || typeof obligation.purpose !== "string" ||
      obligation.purpose.trim().length < 3 || obligation.purpose.length > 300
    ) return json({ error: "invalid_obligation", message: "Each obligation needs taskId, dueAt and purpose." }, 400);

    const dueMs = Date.parse(obligation.dueAt);
    if (!Number.isFinite(dueMs) || dueMs <= Date.now() || dueMs > Date.now() + 30 * 24 * 60 * 60 * 1000) {
      return json({ error: "invalid_due_date", message: "dueAt must be in the next 30 days." }, 400);
    }

    let amountAtoms: bigint;
    try {
      amountAtoms = parseTokenAmount(obligation.amount);
    } catch (error) {
      return json({ error: "invalid_amount", message: error instanceof Error ? error.message : "Invalid amount" }, 400);
    }

    statements.push(env.DB.prepare(`
      INSERT INTO liquidity_obligations
        (id, business_id, agent_id, task_id, token, amount_atoms, due_at, purpose, status, updated_at)
      VALUES (?, ?, ?, ?, 'USDC', ?, ?, ?, 'planned', datetime('now'))
      ON CONFLICT(agent_id, task_id) DO UPDATE SET
        amount_atoms = excluded.amount_atoms,
        due_at = excluded.due_at,
        purpose = excluded.purpose,
        status = 'planned',
        updated_at = datetime('now')
    `).bind(
      "obl_" + crypto.randomUUID().replaceAll("-", ""),
      agent.business_id,
      agent.id,
      obligation.taskId,
      amountAtoms.toString(),
      new Date(dueMs).toISOString(),
      obligation.purpose.trim()
    ));
  }

  await env.DB.batch(statements);
  const forecast = await buildLiquidityForecast(agent, env);
  const summary = forecast.businessSummary as { conversionRequired: number; blocked: number; totalShortfallUSDC: string };
  if (summary.conversionRequired || summary.blocked) {
    await notifyBusiness(
      env,
      agent.business_id,
      `Upcoming liquidity forecast: ${summary.conversionRequired} task(s) may need conversion and ${summary.blocked} are currently blocked. Projected shortfall: ${summary.totalShortfallUSDC} USDC.`
    );
  }
  return json(forecast, 201);
}

async function getLiquidityForecast(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  return json(await buildLiquidityForecast(agent, env));
}

async function updateObligationStatus(request: Request, env: Env, taskId: string, status: "fulfilled" | "cancelled"): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const result = await env.DB.prepare(
    "UPDATE liquidity_obligations SET status = ?, updated_at = datetime('now') WHERE agent_id = ? AND task_id = ? AND status = 'planned'"
  ).bind(status, agent.id, taskId).run();
  if ((result.meta?.changes ?? 0) !== 1) return json({ error: "planned_obligation_not_found" }, 404);
  return json({ taskId, status });
}

async function getAgentLiquidity(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const rows = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.address, w.scope, w.purpose, b.token, b.confirmed_atoms,
           b.reserved_atoms, b.observed_at, b.source
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id
    WHERE w.business_id = ? AND w.status = 'active' AND w.network = 'solana'
      AND (
        (w.purpose = 'operating' AND (
          (w.scope = 'agent' AND w.agent_id = ?) OR
          (w.scope = 'business' AND ? = 1)
        )) OR
        (w.purpose = 'api_payment' AND w.scope = 'business')
      )
    ORDER BY w.scope, w.address, b.token
  `).bind(agent.business_id, agent.id, agent.can_use_business_treasury).all<{
    wallet_id: string;
    address: string;
    scope: string;
    purpose: string;
    token: string;
    confirmed_atoms: string;
    reserved_atoms: string;
    observed_at: string;
    source: string;
  }>();

  const balances = (rows.results ?? []).map((row) => {
    const decimals = row.token === "SOL" ? 9 : 6;
    const confirmed = BigInt(row.confirmed_atoms);
    const reserved = BigInt(row.reserved_atoms);
    const available = confirmed > reserved ? confirmed - reserved : 0n;
    const ageMs = Date.now() - Date.parse(row.observed_at);
    return {
      walletId: row.wallet_id,
      address: row.address,
      scope: row.scope,
      purpose: row.purpose,
      token: row.token,
      confirmed: formatTokenAmount(confirmed, decimals),
      reserved: formatTokenAmount(reserved, decimals),
      available: formatTokenAmount(available, decimals),
      observedAt: row.observed_at,
      source: row.source,
      fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60 * 1000
    };
  });

  return json({ network: "solana", balances });
}

async function listAgentOperations(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const rows = await env.DB.prepare(`
    SELECT id, task_id, token, amount_atoms, status, action, available_atoms,
           shortfall_atoms, source_wallet_id, transaction_hash, received_output_atoms, created_at
    FROM operations
    WHERE agent_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).bind(agent.id).all<{
    id: string;
    task_id: string;
    token: string;
    amount_atoms: string;
    status: string;
    action: string;
    available_atoms: string;
    shortfall_atoms: string;
    source_wallet_id: string | null;
    transaction_hash: string | null;
    received_output_atoms: string | null;
    created_at: string;
  }>();

  return json({
    operations: (rows.results ?? []).map((row) => ({
      operationId: row.id,
      taskId: row.task_id,
      token: row.token,
      amount: formatTokenAmount(BigInt(row.amount_atoms), 6),
      status: row.status,
      action: row.action,
      available: formatTokenAmount(BigInt(row.available_atoms), 6),
      shortfall: formatTokenAmount(BigInt(row.shortfall_atoms), 6),
      sourceWalletId: row.source_wallet_id,
      transactionHash: row.transaction_hash,
      receivedUSDC: row.received_output_atoms
        ? formatTokenAmount(BigInt(row.received_output_atoms), 6)
        : null,
      createdAt: row.created_at
    }))
  });
}

async function getOperation(request: Request, env: Env, operationId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const operation = await env.DB.prepare(`
    SELECT id, task_id, network, token, amount_atoms, status, action,
           available_atoms, shortfall_atoms, source_wallet_id, transaction_hash, received_output_atoms,
           settlement_note, created_at
    FROM operations WHERE id = ? AND agent_id = ? LIMIT 1
  `).bind(operationId, agent.id).first<Record<string, string>>();
  if (!operation) return json({ error: "operation_not_found" }, 404);

  const reservations = await env.DB.prepare(
    "SELECT id, amount_atoms, status, expires_at, token FROM reservations WHERE operation_id = ? ORDER BY created_at ASC"
  ).bind(operationId).all<{ id: string; amount_atoms: string; status: string; expires_at: string; token: string }>();

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
    sourceWalletId: operation.source_wallet_id ?? null,
    transactionHash: operation.transaction_hash ?? null,
    receivedUSDC: operation.received_output_atoms
      ? formatTokenAmount(BigInt(operation.received_output_atoms), 6)
      : null,
    settlementNote: operation.settlement_note ?? null,
    reservations: (reservations.results ?? []).map((reservation) => ({
      id: reservation.id,
      amount: formatTokenAmount(BigInt(reservation.amount_atoms), reservation.token === "SOL" ? 9 : 6),
      token: reservation.token,
      status: reservation.status,
      expiresAt: reservation.expires_at
    })),
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
      try {
        const database = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
        if (database?.ok !== 1) throw new Error("D1 health query returned no result");
        return json({
          service: "nerith-api",
          status: "ok",
          version: "0.3.0",
          database: "connected",
          dashboard: true,
          telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET)
        });
      } catch {
        return json({
          service: "nerith-api",
          status: "degraded",
          database: "unavailable"
        }, 503);
      }
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") return bootstrapBusiness(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/agents") return provisionAgent(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/agents") return listBusinessAgents(request, env);
    const rotateAgentMatch = url.pathname.match(/^\/v1\/admin\/agents\/([a-zA-Z0-9_-]+)\/rotate-key$/);
    if (request.method === "POST" && rotateAgentMatch) return rotateAgentKey(request, env, rotateAgentMatch[1]);
    const disableAgentMatch = url.pathname.match(/^\/v1\/admin\/agents\/([a-zA-Z0-9_-]+)\/disable$/);
    if (request.method === "POST" && disableAgentMatch) return disableAgent(request, env, disableAgentMatch[1]);
    const disableWalletMatch = url.pathname.match(/^\/v1\/admin\/wallets\/([a-zA-Z0-9_-]+)\/disable$/);
    if (request.method === "POST" && disableWalletMatch) return disableWallet(request, env, disableWalletMatch[1]);
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/link-codes") return createTelegramLinkCode(request, env);
    if (request.method === "POST" && url.pathname === "/v1/telegram/webhook") return telegramWebhook(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/wallets") return registerWallet(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/balances") return upsertBalanceSnapshot(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/balances/sync") return syncSolanaBalances(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/reservations/expire") return expireReservationsAdmin(request, env);
    if (request.method === "POST" && url.pathname === "/v1/liquidity/requests") return createLiquidityRequest(request, env);
    if (request.method === "GET" && url.pathname === "/v1/liquidity") return getAgentLiquidity(request, env);
    if (request.method === "POST" && url.pathname === "/v1/liquidity/forecast") return upsertLiquidityForecast(request, env);
    if (request.method === "GET" && url.pathname === "/v1/liquidity/forecast") return getLiquidityForecast(request, env);
    const obligationMatch = url.pathname.match(/^\/v1\/liquidity\/forecast\/([a-zA-Z0-9._:-]+)\/(fulfilled|cancelled)$/);
    if (request.method === "POST" && obligationMatch) {
      return updateObligationStatus(request, env, obligationMatch[1], obligationMatch[2] as "fulfilled" | "cancelled");
    }
    if (request.method === "GET" && url.pathname === "/v1/operations") return listAgentOperations(request, env);
    if (request.method === "POST" && url.pathname === "/v1/conversions/quote") return requestSwapQuote(request, env);
    if (request.method === "POST" && url.pathname === "/v1/conversions/prepare") return prepareSwapTransaction(request, env);
    if (request.method === "POST" && url.pathname === "/v1/conversions/track") return trackSwapTransaction(request, env);
    const swapStatusMatch = url.pathname.match(/^\/v1\/conversions\/status\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && swapStatusMatch) return getSwapStatus(request, env, swapStatusMatch[1]);
    const completeMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)\/complete$/);
    if (request.method === "POST" && completeMatch) return completeOperation(request, env, completeMatch[1]);
    const releaseMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)\/release$/);
    if (request.method === "POST" && releaseMatch) return releaseOperation(request, env, releaseMatch[1]);
    const operationMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && operationMatch) return getOperation(request, env, operationMatch[1]);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(dashboardHtml, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        }
      });
    }
    return json({ error: "not_found" }, 404);
  }
};
