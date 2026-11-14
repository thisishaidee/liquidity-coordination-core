import { dashboardHtml } from "./dashboard";
import { businessDashboardHtml } from "./business-dashboard";
import { pixelFieldSvg } from "./pixel-field";
import { landingHtml } from "./landing";
import { controlHtml } from "./control";
import { privacyHtml, termsHtml } from "./legal";
import {
  evaluateLiquidity,
  makeOperationId,
  parseTokenAmount,
  formatTokenAmount
} from "./core";
import { canCreateTelegramRequest, canReviewTelegramRequest, isTelegramDraftCancellable, normalizeTelegramCommand, parseTelegramRequestAmount, isValidTelegramRequestPurpose } from "./telegram-request";
import { decryptTotpSecret, encryptTotpSecret, generateTotpSecret, verifyTotpStep } from "./telegram-totp";
import { verifySolSourceDebit, type SolanaSettlementTransaction } from "./settlement";
import { parseHermesPaymentPayload, parseHermesPaymentRequirement, parseHermesPaymentReceipt, verifyHermesPaymentTransaction, type HermesPaymentRequirement } from "./x402";
import { describeAdminRoute, isAllowedAdminOrigin, isDashboardRoleAllowed, matchesBusinessScope } from "./admin-auth";
import { decodeSolanaAddress, verifySolanaMessageSignature } from "./solana-wallet-verification";
import { evaluatePaymentIntentPolicy, type PaymentIntent, type PaymentPolicy, type PolicyWalletSnapshot } from "./transaction-policy";
import { fetchFinalizedSolanaTransaction } from "./solana-finalized-transaction";
import { verifySolanaTokenTransfer, type SolanaPaymentTransaction } from "./payment-settlement";
import { verifySolanaNetworkFee } from "./solana-network-fee";
import { fetchFinalizedSplTokenBalance } from "./solana-finalized-balance";

interface Env {
  DB: D1Database;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  ADMIN_ALLOWED_ORIGINS?: string;
  SOLANA_RPC_URL?: string;
  SOLANA_USDC_MINT?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_TOTP_ENCRYPTION_KEY?: string;
  NERITH_SUPPORT_URL?: string;
  NERITH_PUBLIC_URL?: string;
  NERITH_TEST_MODE?: string;
  HERMES_TEST_402_FIXTURE?: string;
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

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  let difference = a.length ^ b.length;
  for (let i = 0; i < 64; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function isBootstrapTokenAuthorized(request: Request, env: Env): Promise<boolean> {
  const configured = env.ADMIN_BOOTSTRAP_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!configured || !supplied || !(await constantTimeEqual(configured, supplied))) return false;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!isAllowedAdminOrigin(origin, new URL(request.url).origin, env.ADMIN_ALLOWED_ORIGINS)) return false;
  }
  return true;
}

async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const url = new URL(request.url);
  let body: Record<string, unknown> | null = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 256 * 1024) return false;
    body = await readJson(request.clone());
  }
  const target = describeAdminRoute(request.method, url.pathname, url.searchParams, body);
  if (target.kind === "global") return isBootstrapTokenAuthorized(request, env);
  if (target.kind !== "business") return false;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (!isAllowedAdminOrigin(origin, url.origin, env.ADMIN_ALLOWED_ORIGINS)) return false;
  }
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)nerith_admin_session=([a-f0-9]{64})(?:;|$)/);
  if (!match) return false;
  const hash = await sha256(match[1]);
  const session = await env.DB.prepare(
    "SELECT business_id, role, telegram_user_id FROM admin_sessions WHERE token_hash = ? AND julianday(expires_at) > julianday('now') LIMIT 1"
  ).bind(hash).first<{ business_id: string | null; role: string; telegram_user_id: string | null }>();
  if (!session?.business_id || !isDashboardRoleAllowed(session.role, request.method)) return false;
  if (session.telegram_user_id) {
    const membership = await env.DB.prepare(
      "SELECT dashboard_role FROM telegram_connections WHERE business_id = ? AND telegram_user_id = ? AND status = 'active' LIMIT 1"
    ).bind(session.business_id, session.telegram_user_id).first<{ dashboard_role: string }>();
    if (!membership || membership.dashboard_role !== session.role) return false;
  }

  let resourceBusinessId: string | null = null;
  if (target.resource) {
    const table = target.resource.table;
    const row = await env.DB.prepare(
      "SELECT business_id FROM " + table + " WHERE id = ? LIMIT 1"
    ).bind(target.resource.id).first<{ business_id: string }>();
    if (!row?.business_id) return false;
    resourceBusinessId = row.business_id;
  }
  if (target.businessId && resourceBusinessId && target.businessId !== resourceBusinessId) return false;
  const requestedBusinessId = target.businessId ?? resourceBusinessId;
  return matchesBusinessScope(session.business_id, requestedBusinessId);
}

async function createAdminSession(request: Request, env: Env): Promise<Response> {
  if (!(await isBootstrapTokenAuthorized(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request.clone());
  if (!body || typeof body.businessId !== "string" || !/^biz_[a-f0-9]{32}$/i.test(body.businessId)) {
    return json({ error: "business_id_required" }, 400);
  }
  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(body.businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  const token = newSecret("");
  const hash = await sha256(token);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO admin_sessions (token_hash, business_id, expires_at, role) VALUES (?, ?, ?, 'owner')")
    .bind(hash, business.id, expiresAt).run();
  return new Response(JSON.stringify({ authenticated: true, businessId: business.id, expiresAt }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": "nerith_admin_session=" + token + "; Path=/v1/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200"
    }
  });
}
async function getCurrentAdminSession(request: Request, env: Env): Promise<Response> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)nerith_admin_session=([a-f0-9]{64})(?:;|$)/);
  if (!match) return json({ authenticated: false });
  const session = await env.DB.prepare(
    "SELECT business_id, role, telegram_user_id, expires_at FROM admin_sessions WHERE token_hash = ? AND julianday(expires_at) > julianday('now') LIMIT 1"
  ).bind(await sha256(match[1])).first<{ business_id: string; role: string; telegram_user_id: string | null; expires_at: string }>();
  if (!session) return json({ authenticated: false });
  if (session.telegram_user_id) {
    const membership = await env.DB.prepare(
      "SELECT dashboard_role FROM telegram_connections WHERE business_id = ? AND telegram_user_id = ? AND status = 'active' LIMIT 1"
    ).bind(session.business_id, session.telegram_user_id).first<{ dashboard_role: string }>();
    if (!membership || membership.dashboard_role !== session.role) return json({ authenticated: false });
  }
  return json({ authenticated: true, businessId: session.business_id, role: session.role, expiresAt: session.expires_at });
}

async function consumeTelegramLoginTicket(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!isAllowedAdminOrigin(origin, new URL(request.url).origin, env.ADMIN_ALLOWED_ORIGINS)) return json({ error: "origin_not_allowed" }, 403);
  const body = await readJson(request);
  if (!body || typeof body.ticket !== "string" || !/^[a-f0-9]{64}$/i.test(body.ticket)) return json({ error: "invalid_login_ticket" }, 400);
  const tokenHash = await sha256(body.ticket);
  const ticket = await env.DB.prepare(
    "SELECT business_id, chat_id, telegram_user_id, role FROM telegram_login_tickets WHERE token_hash = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now') LIMIT 1"
  ).bind(tokenHash).first<{ business_id: string; chat_id: string; telegram_user_id: string; role: string }>();
  if (!ticket) return json({ error: "login_ticket_invalid_or_expired" }, 401);
  const claim = await env.DB.prepare(
    "UPDATE telegram_login_tickets SET consumed_at = datetime('now') WHERE token_hash = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')"
  ).bind(tokenHash).run();
  if ((claim.meta?.changes ?? 0) !== 1) return json({ error: "login_ticket_already_used" }, 409);
  const membership = await env.DB.prepare(
    "SELECT dashboard_role FROM telegram_connections WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active' LIMIT 1"
  ).bind(ticket.business_id, ticket.chat_id, ticket.telegram_user_id).first<{ dashboard_role: string }>();
  if (!membership || membership.dashboard_role !== ticket.role) return json({ error: "workspace_access_revoked" }, 403);
  const sessionToken = newSecret("");
  const sessionHash = await sha256(sessionToken);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO admin_sessions (token_hash, business_id, expires_at, role, telegram_user_id) VALUES (?, ?, ?, ?, ?)"
  ).bind(sessionHash, ticket.business_id, expiresAt, ticket.role, ticket.telegram_user_id).run();
  return new Response(JSON.stringify({ authenticated: true, businessId: ticket.business_id, role: ticket.role, expiresAt }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "set-cookie": "nerith_admin_session=" + sessionToken + "; Path=/v1/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=43200" }
  });
}

async function endAdminSession(request: Request, env: Env): Promise<Response> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)nerith_admin_session=([a-f0-9]{64})(?:;|$)/);
  if (match) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash = ?")
      .bind(await sha256(match[1])).run();
  }
  return new Response(JSON.stringify({ authenticated: false }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": "nerith_admin_session=; Path=/v1/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
    }
  });
}

async function getBusinessWorkspace(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId");
  if (!businessId) return json({ error: "business_id_required" }, 400);
  const business = await env.DB.prepare("SELECT id, name, created_at FROM businesses WHERE id = ?")
    .bind(businessId).first<{ id: string; name: string; created_at: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  const [agents, wallets, telegram] = await Promise.all([
    env.DB.prepare("SELECT id, name, status, can_use_business_treasury, created_at FROM agents WHERE business_id = ? ORDER BY created_at ASC")
      .bind(businessId).all<{ id: string; name: string; status: string; can_use_business_treasury: number; created_at: string }>(),
    env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM wallets WHERE business_id = ?")
      .bind(businessId).first<{ total: number; active: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS active FROM telegram_connections WHERE business_id = ? AND status = 'active'")
      .bind(businessId).first<{ active: number }>()
  ]);
  return json({
    business,
    agents: (agents.results ?? []).map(a => ({ id: a.id, name: a.name, status: a.status, canUseBusinessTreasury: a.can_use_business_treasury === 1, createdAt: a.created_at })),
    wallets: { total: wallets?.total ?? 0, active: wallets?.active ?? 0 },
    telegramConnections: telegram?.active ?? 0
  });
}

async function authenticate(request: Request, db: D1Database): Promise<AgentRow | null> {
  const key = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key) return null;
  const hash = await sha256(key);
  return db.prepare(
    "SELECT id, business_id, status, can_use_business_treasury FROM agents WHERE api_key_hash = ? LIMIT 1"
  ).bind(hash).first<AgentRow>();
}

async function enforceAgentRateLimit(env: Env, agentId: string, action: string, limit: number, windowSeconds: number): Promise<Response | null> {
  const windowKey = Math.floor(Date.now() / (windowSeconds * 1000));
  const bucketKey = agentId + ":" + action;
  await env.DB.prepare(`
    INSERT INTO api_rate_limits (bucket_key, window_key, request_count)
    VALUES (?, ?, 1)
    ON CONFLICT(bucket_key) DO UPDATE SET
      request_count = CASE WHEN api_rate_limits.window_key = excluded.window_key THEN api_rate_limits.request_count + 1 ELSE 1 END,
      window_key = excluded.window_key,
      updated_at = datetime('now')
  `).bind(bucketKey, windowKey).run();
  const row = await env.DB.prepare("SELECT request_count FROM api_rate_limits WHERE bucket_key = ? AND window_key = ?")
    .bind(bucketKey, windowKey).first<{ request_count: number }>();
  if (!row || row.request_count <= limit) return null;
  const retryAfter = Math.max(1, (windowKey + 1) * windowSeconds - Math.floor(Date.now() / 1000));
  return new Response(JSON.stringify({ error: "rate_limited", retryAfterSeconds: retryAfter }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": String(retryAfter) }
  });
}

function newSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return prefix + hex;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > 256_000) return null;
  try {
    if (!request.body) return null;
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 256_000) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch { return null; }
}

function telegramSupportMarkup(env: Env): Record<string, unknown> | undefined {
  if (!env.NERITH_SUPPORT_URL) return undefined;
  try {
    const supportUrl = new URL(env.NERITH_SUPPORT_URL);
    if (supportUrl.protocol !== "https:" || supportUrl.username || supportUrl.password) return undefined;
    return { inline_keyboard: [[{ text: "NERITH website & support", url: supportUrl.toString() }]] };
  } catch { return undefined; }
}

async function sendTelegramMessage(env: Env, chatId: string, text: string, replyMarkup?: Record<string, unknown>): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  try {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: text.length > 3900 ? text.slice(0, 3880) + "\n… message truncated" : text,
      disable_web_page_preview: true
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await response.json() as { ok?: boolean };
    return response.ok && result.ok === true;
  } catch {
    return false;
  }
}

async function deliverTelegramOutbox(env: Env): Promise<{ delivered: number; retried: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { delivered: 0, retried: 0 };
  const due = await env.DB.prepare(`
    SELECT id, chat_id, message, attempts
    FROM telegram_notification_outbox
    WHERE (status = 'pending' AND next_attempt_at <= datetime('now'))
       OR (status = 'sending' AND locked_until <= datetime('now'))
    ORDER BY created_at ASC
    LIMIT 20
  `).all<{ id: string; chat_id: string; message: string; attempts: number }>();

  let delivered = 0;
  let retried = 0;
  const retryDelays = [60, 300, 900, 3600, 21600, 43200, 86400];

  for (const item of due.results ?? []) {
    const claim = await env.DB.prepare(`
      UPDATE telegram_notification_outbox
      SET status = 'sending', locked_until = datetime('now', '+2 minutes')
      WHERE id = ?
        AND ((status = 'pending' AND next_attempt_at <= datetime('now'))
          OR (status = 'sending' AND locked_until <= datetime('now')))
    `).bind(item.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    const attempt = item.attempts + 1;
    const sent = await sendTelegramMessage(env, item.chat_id, item.message);
    if (sent) {
      await env.DB.prepare(`
        UPDATE telegram_notification_outbox
        SET status = 'sent', attempts = ?, sent_at = datetime('now'),
            locked_until = NULL, last_error = NULL
        WHERE id = ? AND status = 'sending'
      `).bind(attempt, item.id).run();
      delivered++;
      continue;
    }

    const exhausted = attempt >= 8;
    const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
    await env.DB.prepare(`
      UPDATE telegram_notification_outbox
      SET status = ?, attempts = ?, next_attempt_at = datetime('now', ?),
          locked_until = NULL, last_error = 'telegram_delivery_failed'
      WHERE id = ? AND status = 'sending'
    `).bind(exhausted ? "failed" : "pending", attempt, `+${delay} seconds`, item.id).run();
    retried++;
  }
  return { delivered, retried };
}

async function notifyBusiness(env: Env, businessId: string, message: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    const connections = await env.DB.prepare(
      "SELECT chat_id FROM telegram_connections WHERE business_id = ? AND status = 'active'"
    ).bind(businessId).all<{ chat_id: string }>();
    const statements = (connections.results ?? []).map((connection) =>
      env.DB.prepare(`
        INSERT INTO telegram_notification_outbox
          (id, business_id, chat_id, message, status, attempts, next_attempt_at)
        VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'))
      `).bind("tn_" + crypto.randomUUID().replaceAll("-", ""), businessId, connection.chat_id, message)
    );
    if (statements.length) {
      await env.DB.batch(statements);
      await deliverTelegramOutbox(env);
    }
  } catch {
    // Alert delivery must never roll back a liquidity operation.
  }
}

async function createTelegramLinkCode(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string") return json({ error: "invalid_request" }, 400);
  const dashboardRole = body.dashboardRole === undefined ? "analyst" : body.dashboardRole;
  if (dashboardRole !== "admin" && dashboardRole !== "analyst") return json({ error: "invalid_dashboard_role" }, 400);
  if (dashboardRole === "admin") {
    const cookie = request.headers.get("cookie") ?? "";
    const match = cookie.match(/(?:^|;\s*)nerith_admin_session=([a-f0-9]{64})(?:;|$)/);
    if (!match) return json({ error: "owner_required_for_admin_invitation" }, 403);
    const session = await env.DB.prepare("SELECT role FROM admin_sessions WHERE token_hash = ? AND julianday(expires_at) > julianday('now') LIMIT 1")
      .bind(await sha256(match[1])).first<{ role: string }>();
    if (session?.role !== "owner") return json({ error: "owner_required_for_admin_invitation" }, 403);
  }

  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(body.businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ error: "telegram_not_configured", message: "Configure the bot token and webhook secret first." }, 409);
  }
  let botUsername = env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "");
  if (!botUsername) {
    try {
      const identityResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      const identity = await identityResponse.json() as { ok?: boolean; result?: { username?: string } };
      if (identityResponse.ok && identity.ok && identity.result?.username) botUsername = identity.result.username;
    } catch {
      // Return a controlled configuration error below.
    }
  }
  if (!botUsername) return json({ error: "telegram_bot_identity_unavailable" }, 502);

  const code = newSecret("");
  const codeHash = await sha256(code);
  const linkId = "tlg_" + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "INSERT INTO telegram_link_codes (id, business_id, code_hash, expires_at, dashboard_role) VALUES (?, ?, ?, ?, ?)"
  ).bind(linkId, business.id, codeHash, expiresAt, dashboardRole).run();

  return json({
    linkId,
    code,
    expiresAt,
    dashboardRole,
    deepLink: `https://t.me/${botUsername}?start=${code}`,
    instruction: "Open the bot link from the private Telegram account that should operate this business. The linked account can create and review requests; Google Authenticator is required for decisions on its own requests. This code works once and expires in 15 minutes."
  }, 201);
}

async function startTelegramLiquidityRequest(env: Env, chatId: string, userId: string, businessId: string): Promise<void> {
  const agents = await env.DB.prepare("SELECT id, name FROM agents WHERE business_id = ? AND status = 'active' ORDER BY name ASC LIMIT 8").bind(businessId).all<{ id: string; name: string }>();
  const available = agents.results ?? [];
  if (!available.length) {
    await sendTelegramMessage(env, chatId, "There are no active agents in this workspace. Add or activate an agent before creating a request.");
    return;
  }
  const agentChoices = JSON.stringify(available.map(agent => agent.id));
  await env.DB.prepare("INSERT INTO telegram_request_drafts (business_id, chat_id, telegram_user_id, step, agent_choices, expires_at) VALUES (?, ?, ?, 'agent', ?, datetime('now', '+15 minutes')) ON CONFLICT(business_id, chat_id, telegram_user_id) DO UPDATE SET agent_id = NULL, agent_choices = excluded.agent_choices, amount = NULL, purpose = NULL, task_id = NULL, step = 'agent', expires_at = datetime('now', '+15 minutes'), updated_at = datetime('now')").bind(businessId, chatId, userId, agentChoices).run();
  const choices = available.map((agent, index) => (index + 1) + ". " + agent.name).join("\n");
  await sendTelegramMessage(env, chatId, "New liquidity request · Step 1 of 3\n\nWhich agent needs the funds? Reply with its number:\n\n" + choices + "\n\nSend /cancel at any time to stop.");
}

async function continueTelegramLiquidityRequest(env: Env, chatId: string, userId: string, businessId: string, answer: string): Promise<boolean> {
  const draft = await env.DB.prepare("SELECT step, agent_id, agent_choices, amount, purpose, expires_at, CASE WHEN julianday(expires_at) <= julianday('now') THEN 1 ELSE 0 END AS expired FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? LIMIT 1").bind(businessId, chatId, userId).first<{ step: string; agent_id: string | null; agent_choices: string; amount: string | null; purpose: string | null; expires_at: string; expired: number }>();
  if (!draft) return false;
  if (draft.expired === 1) {
    await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(businessId, chatId, userId).run();
    await sendTelegramMessage(env, chatId, "Your request draft expired. Send /newrequest to start again.");
    return true;
  }
  if (draft.step === "agent") {
    let choices: string[] = [];
    try {
      const parsed: unknown = JSON.parse(draft.agent_choices);
      if (Array.isArray(parsed) && parsed.every(item => typeof item === "string")) choices = parsed;
    } catch {
      choices = [];
    }
    const index = Number(answer.trim());
    if (!Number.isInteger(index) || index < 1 || index > choices.length) {
      await sendTelegramMessage(env, chatId, "Reply with one of the agent numbers shown, or send /cancel.");
      return true;
    }
    const agent = await env.DB.prepare("SELECT id, name FROM agents WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1").bind(choices[index - 1], businessId).first<{ id: string; name: string }>();
    if (!agent) {
      await sendTelegramMessage(env, chatId, "That agent is no longer active. Send /newrequest to choose again.");
      await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(businessId, chatId, userId).run();
      return true;
    }
    await env.DB.prepare("UPDATE telegram_request_drafts SET agent_id = ?, step = 'amount', updated_at = datetime('now') WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(agent.id, businessId, chatId, userId).run();
    await sendTelegramMessage(env, chatId, "Agent selected: " + agent.name + "\n\nStep 2 of 3 · How much USDC is required? Reply with a positive amount, for example 25 or 12.50.");
    return true;
  }
  if (draft.step === "amount") {
    try {
      parseTelegramRequestAmount(answer.trim());
    } catch {
      await sendTelegramMessage(env, chatId, "Enter a valid positive USDC amount with up to 6 decimal places. Example: 25 or 12.50.");
      return true;
    }
    await env.DB.prepare("UPDATE telegram_request_drafts SET amount = ?, step = 'purpose', updated_at = datetime('now') WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(answer.trim(), businessId, chatId, userId).run();
    await sendTelegramMessage(env, chatId, "Step 3 of 3 · What is the USDC needed for? Give a clear purpose (3–300 characters).");
    return true;
  }
  if (draft.step === "purpose") {
    const purpose = answer.trim();
    if (!isValidTelegramRequestPurpose(purpose) || !draft.agent_id || !draft.amount) {
      await sendTelegramMessage(env, chatId, "Please provide a purpose between 3 and 300 characters, or send /cancel.");
      return true;
    }
    const agentName = (await env.DB.prepare("SELECT name FROM agents WHERE id = ? AND business_id = ? AND status = 'active'").bind(draft.agent_id, businessId).first<{ name: string }>())?.name;
    if (!agentName) {
      await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(businessId, chatId, userId).run();
      await sendTelegramMessage(env, chatId, "That agent is no longer active. Send /newrequest to choose an active agent.");
      return true;
    }
    await env.DB.prepare("UPDATE telegram_request_drafts SET purpose = ?, step = 'confirm', updated_at = datetime('now') WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(purpose, businessId, chatId, userId).run();
    await sendTelegramMessage(env, chatId, "Review your liquidity request\n\nAgent: " + agentName + "\nAmount: " + draft.amount + " USDC\nPurpose: " + purpose + "\nNetwork: Solana\nAsset: USDC\n\nReply CONFIRM to submit this request and reserve eligible funds, or /cancel to discard it.");
    return true;
  }
  if (draft.step === "submitting") {
    await sendTelegramMessage(env, chatId, "Your confirmed request is already being processed. Please wait for the result.");
    return true;
  }
  if (draft.step === "confirm") {
    if (answer.trim().toUpperCase() !== "CONFIRM") {
      await sendTelegramMessage(env, chatId, "Reply CONFIRM to submit this exact request, or /cancel to discard it.");
      return true;
    }
    const claim = await env.DB.prepare("UPDATE telegram_request_drafts SET step = 'submitting', updated_at = datetime('now') WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND step = 'confirm' AND julianday(expires_at) > julianday('now')").bind(businessId, chatId, userId).run();
    if ((claim.meta?.changes ?? 0) !== 1) {
      await sendTelegramMessage(env, chatId, "This request is already being processed or has expired. Check /operations or start a new request.");
      return true;
    }
    const purpose = draft.purpose ?? "";
    if (!draft.agent_id || !draft.amount || purpose.length < 3) {
      await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(businessId, chatId, userId).run();
      await sendTelegramMessage(env, chatId, "This request draft is incomplete. Send /newrequest to start again.");
      return true;
    }
    const agent = await env.DB.prepare("SELECT id, business_id, status, can_use_business_treasury FROM agents WHERE id = ? AND business_id = ? AND status = 'active' LIMIT 1").bind(draft.agent_id, businessId).first<AgentRow>();
    if (!agent) {
      await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(businessId, chatId, userId).run();
      await sendTelegramMessage(env, chatId, "That agent is no longer active. Send /newrequest to choose an active agent.");
      return true;
    }
    const taskId = "telegram-" + crypto.randomUUID().replaceAll("-", "");
    const internalRequest = new Request("https://nerith.internal/v1/liquidity/requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: taskId, network: "solana", token: "USDC", amount: draft.amount, purpose: purpose }) });
    const response = await createLiquidityRequest(internalRequest, env, agent, { chatId: chatId, userId: userId });
    const result = await response.json() as Record<string, unknown>;
    await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?").bind(businessId, chatId, userId).run();
    if (!response.ok) {
      await sendTelegramMessage(env, chatId, "NERITH could not create this request: " + String(result.message ?? result.error ?? "request_failed") + ". No approval was recorded.");
      return true;
    }
    const operationId = typeof result.operationId === "string" ? result.operationId : "";
    const requested = result.requested as { amount?: string } | undefined;
    const liquidity = result.liquidity as { shortfall?: string } | undefined;
    const action = String(result.action ?? "");
    const status = String(result.status ?? "");
    const agentName = (await env.DB.prepare("SELECT name FROM agents WHERE id = ?").bind(agent.id).first<{ name: string }>())?.name ?? "Selected agent";
    const prepared = status === "reserved" && action === "direct_fulfillment";
    const message = [
      prepared ? "Liquidity request prepared" : "Liquidity request recorded",
      "",
      "Agent: " + agentName,
      "Amount: " + String(requested?.amount ?? draft.amount) + " USDC",
      "Purpose: " + purpose,
      "Status: " + status,
      "Operation: " + operationId,
      prepared ? "Funds are reserved in the internal ledger. A different authorised approver must review this request." : "This request is not ready for approval. " + (liquidity?.shortfall ? "Current USDC shortfall: " + liquidity.shortfall + "." : "Check liquidity and wallet eligibility in NERITH."),
      "",
      "No transaction has been signed, broadcast or transferred."
    ].join("\n");
    await sendTelegramMessage(env, chatId, message);
    return true;
  }
  return true;
}

async function handleTelegramCommand(
  env: Env,
  chatId: string,
  userId: string,
  rawText: string
): Promise<void> {
  const rawCommand = (rawText.trim().split(/\s+/, 1)[0] ?? "").split("@", 1)[0].toLowerCase();
  const command = normalizeTelegramCommand(rawCommand);

  if (command === "/login") {
    const linked = await env.DB.prepare(`
      SELECT c.business_id, c.dashboard_role, b.name AS business_name
      FROM telegram_connections c JOIN businesses b ON b.id = c.business_id
      WHERE c.chat_id = ? AND c.telegram_user_id = ? AND c.status = 'active'
      ORDER BY b.name COLLATE NOCASE LIMIT 10
    `).bind(chatId, userId).all<{ business_id: string; dashboard_role: string; business_name: string }>();
    const workspaces = linked.results ?? [];
    if (!workspaces.length) {
      await sendTelegramMessage(env, chatId, "No active NERITH workspace is linked to this Telegram account. Ask a workspace administrator for a private invitation first.");
      return;
    }
    await env.DB.prepare("DELETE FROM telegram_login_tickets WHERE julianday(expires_at) <= julianday('now') AND created_at < datetime('now', '-1 day')").run();
    const recentTickets = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM telegram_login_tickets WHERE chat_id = ? AND telegram_user_id = ? AND created_at >= datetime('now', '-10 minutes')"
    ).bind(chatId, userId).first<{ total: number }>();
    if ((recentTickets?.total ?? 0) >= 30) {
      await sendTelegramMessage(env, chatId, "Too many sign-in links were requested recently. Wait a few minutes and try /login again.");
      return;
    }
    const baseUrl = (env.NERITH_PUBLIC_URL || "https://neritth.pages.dev").replace(/\/$/, "");
    const keyboard: Array<Array<{ text: string; url: string }>> = [];
    for (const workspace of workspaces) {
      const ticket = newSecret("");
      const ticketHash = await sha256(ticket);
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await env.DB.prepare(
        "INSERT INTO telegram_login_tickets (token_hash, business_id, chat_id, telegram_user_id, role, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(ticketHash, workspace.business_id, chatId, userId, workspace.dashboard_role, expiresAt).run();
      keyboard.push([{ text: workspace.business_name + " · " + workspace.dashboard_role, url: baseUrl + "/dashboard#login_ticket=" + ticket }]);
    }
    await sendTelegramMessage(env, chatId, "Choose the NERITH workspace to open. Each sign-in link expires in 5 minutes and works once.", { inline_keyboard: keyboard });
    return;
  }

  if (command === "/start" && !rawText.trim().match(/^\/start\s+[a-f0-9]{64}$/i)) {
    await sendTelegramMessage(
      env,
      chatId,
      "Welcome to NERITH.\n\nYour NERITH workspace is your team’s private operating space. It keeps your agents, registered business wallets, liquidity requests, permissions and operating limits together. It is not a wallet, and NERITH does not hold your funds.\n\nHere is how to get started:\n1. A workspace administrator creates the workspace at https://neritth.pages.dev/control and saves the first agent API key.\n2. The administrator registers the business’s public operating wallet and configures agent access and limits. Never share a seed phrase or private key.\n3. The administrator connects this Telegram bot and sends you a private invitation. Open that invitation from this private chat to link your account.\n\nOnce you are linked, use /guide for the setup and usage guide or /help for commands. This bot connects you to an existing workspace; it does not create one.\n\nNERITH records requests and business decisions. It does not sign or broadcast transactions or move funds.",
      telegramSupportMarkup(env)
    );
    return;
  }

  const connection = await env.DB.prepare(`
    SELECT c.business_id, c.permission, b.name AS business_name
    FROM telegram_connections c
    JOIN businesses b ON b.id = c.business_id
    WHERE c.chat_id = ? AND c.telegram_user_id = ? AND c.status = 'active'
    ORDER BY c.linked_at DESC
    LIMIT 1
  `).bind(chatId, userId).first<{ business_id: string; business_name: string; permission: string }>();

  if (!connection) {
    const unlinkedMessage = command === "/guide"
      ? "NERITH workspace setup\n\nA workspace is your team’s private operating space. It brings your agents, registered business wallets, liquidity requests, permissions and operating limits together. It is not a wallet, and NERITH does not hold funds.\n\n1. A workspace administrator creates the workspace at https://neritth.pages.dev/control and saves the first agent API key.\n2. The administrator registers the public operating wallet and configures agent access and limits. Never share a seed phrase or private key.\n3. The administrator connects this Telegram bot and creates a private, one-use invitation for each team member.\n4. Each team member opens their invitation from this private chat. Once linked, use /status, /agents, /newrequest and /help.\n\nThis bot connects you to an existing workspace; it cannot create one or sign or broadcast transactions."
      : "You’re not connected to a NERITH workspace yet. A workspace is your team’s private operating space for its agents, business wallets, liquidity requests, permissions and limits. It is created by an administrator on the NERITH website, not inside Telegram.\n\nIf your team already has a workspace, ask its administrator for a private invitation and open it from this chat. If your team is new to NERITH, the administrator can start at https://neritth.pages.dev/control.\n\nSend /guide for the setup steps or /help for available commands. NERITH does not hold funds or sign transactions.";
    await sendTelegramMessage(env, chatId, unlinkedMessage);
    return;
  }

  const businessId = connection.business_id;
  if (command === "/businessid" || command === "/workspace") {
    const workspaces = await env.DB.prepare(`
      SELECT DISTINCT b.id AS business_id, b.name AS business_name
      FROM telegram_connections c
      JOIN businesses b ON b.id = c.business_id
      WHERE c.chat_id = ? AND c.telegram_user_id = ? AND c.status = 'active'
      ORDER BY b.name COLLATE NOCASE
      LIMIT 20
    `).bind(chatId, userId).all<{ business_id: string; business_name: string }>();
    const linkedWorkspaces = workspaces.results ?? [];
    if (linkedWorkspaces.length === 0) {
      await sendTelegramMessage(env, chatId, "No active NERITH business workspace is linked to this Telegram account.");
      return;
    }
    const lines = linkedWorkspaces.map((workspace) =>
      `• ${workspace.business_name}\n  Business ID: ${workspace.business_id}`
    );
    await sendTelegramMessage(
      env,
      chatId,
      `Your linked NERITH workspace${linkedWorkspaces.length === 1 ? "" : "s"}\n\n${lines.join("\n\n")}\n\nKeep this ID private to your business team. It is an identifier, not an admin token or login credential.`
    );
    return;
  }
  if (command === "/setupauth") {
    const key = env.TELEGRAM_TOTP_ENCRYPTION_KEY;
    if (!key || key.length < 32) {
      await sendTelegramMessage(env, chatId, "Authenticator setup is unavailable until the business administrator configures the Telegram authenticator encryption secret.");
      return;
    }
    const secret = await generateTotpSecret();
    const encryptedSecret = await encryptTotpSecret(secret, key);
    await env.DB.prepare(`INSERT INTO telegram_totp_enrollments (business_id, chat_id, telegram_user_id, encrypted_secret, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+10 minutes'))
      ON CONFLICT(business_id, chat_id, telegram_user_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, expires_at = excluded.expires_at, attempts = 0, created_at = datetime('now')`)
      .bind(businessId, chatId, userId, encryptedSecret).run();
    await sendTelegramMessage(env, chatId,
      "Set up Google Authenticator\n\nAdd an account manually using this key:\n" + secret +
      "\n\nThen send /verifyauth followed by the current six-digit code. This key expires in 10 minutes. Do not share it.");
    return;
  }
  if (command === "/verifyauth") {
    const code = rawText.trim().split(/\s+/)[1] ?? "";
    const key = env.TELEGRAM_TOTP_ENCRYPTION_KEY;
    if (!code || !key) {
      await sendTelegramMessage(env, chatId, "Send /verifyauth followed by the six-digit code shown in Google Authenticator.");
      return;
    }
    const enrollment = await env.DB.prepare("SELECT encrypted_secret FROM telegram_totp_enrollments WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND julianday(expires_at) > julianday('now') LIMIT 1")
      .bind(businessId, chatId, userId).first<{ encrypted_secret: string }>();
    if (!enrollment) {
      await sendTelegramMessage(env, chatId, "No active authenticator setup. Send /setupauth to begin again.");
      return;
    }
    const secret = await decryptTotpSecret(enrollment.encrypted_secret, key);
    const step = await verifyTotpStep(secret, code);
    if (step === null) {
      await env.DB.prepare("UPDATE telegram_totp_enrollments SET attempts = attempts + 1 WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?")
        .bind(businessId, chatId, userId).run();
      const attempts = await env.DB.prepare("SELECT attempts FROM telegram_totp_enrollments WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? LIMIT 1")
        .bind(businessId, chatId, userId).first<{ attempts: number }>();
      if ((attempts?.attempts ?? 0) >= 5) {
        await env.DB.prepare("DELETE FROM telegram_totp_enrollments WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?")
          .bind(businessId, chatId, userId).run();
      }
      await sendTelegramMessage(env, chatId, (attempts?.attempts ?? 0) >= 5
        ? "Five incorrect codes. Authenticator enrollment was cancelled. Send /setupauth to begin again."
        : "That code is invalid or expired. Check your device time and try again.");
      return;
    }
    const enabled = await env.DB.prepare("UPDATE telegram_connections SET totp_secret_enc = ?, totp_enabled_at = datetime('now'), last_totp_step = ? WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active'")
      .bind(enrollment.encrypted_secret, step, businessId, chatId, userId).run();
    await env.DB.prepare("DELETE FROM telegram_totp_enrollments WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ?")
      .bind(businessId, chatId, userId).run();
    await sendTelegramMessage(env, chatId, (enabled.meta?.changes ?? 0) === 1
      ? "Google Authenticator is enabled. It will be required to approve or reject requests you submitted yourself."
      : "This Telegram connection is no longer active. Reconnect it before enabling authenticator approval.");
    return;
  }
  if (command === "/confirmapproval") {
    const code = rawText.trim().split(/\s+/)[1] ?? "";
    const encryptionKey = env.TELEGRAM_TOTP_ENCRYPTION_KEY;
    if (!code || !encryptionKey) {
      await sendTelegramMessage(env, chatId, "Send /confirmapproval followed by the current six-digit Google Authenticator code.");
      return;
    }
    const pending = await env.DB.prepare("SELECT id, operation_id, decision, snapshot_hash FROM telegram_pending_approvals WHERE business_id = ? AND telegram_chat_id = ? AND telegram_user_id = ? AND julianday(expires_at) > julianday('now') ORDER BY created_at DESC LIMIT 1")
      .bind(businessId, chatId, userId).first<{ id: string; operation_id: string; decision: string; snapshot_hash: string }>();
    if (!pending) {
      await sendTelegramMessage(env, chatId, "No active approval challenge. Run /review and choose the request again.");
      return;
    }
    const auth = await env.DB.prepare("SELECT totp_secret_enc FROM telegram_connections WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active' AND permission = 'approver' AND totp_enabled_at IS NOT NULL LIMIT 1")
      .bind(businessId, chatId, userId).first<{ totp_secret_enc: string | null }>();
    if (!auth?.totp_secret_enc) {
      await sendTelegramMessage(env, chatId, "Google Authenticator is not enabled. Send /setupauth first.");
      return;
    }
    const secret = await decryptTotpSecret(auth.totp_secret_enc, encryptionKey);
    const step = await verifyTotpStep(secret, code);
    if (step === null) {
      await env.DB.prepare("UPDATE telegram_pending_approvals SET attempts = attempts + 1 WHERE id = ?").bind(pending.id).run();
      const attempts = await env.DB.prepare("SELECT attempts FROM telegram_pending_approvals WHERE id = ? LIMIT 1").bind(pending.id).first<{ attempts: number }>();
      if ((attempts?.attempts ?? 0) >= 5) await env.DB.prepare("DELETE FROM telegram_pending_approvals WHERE id = ?").bind(pending.id).run();
      await sendTelegramMessage(env, chatId, (attempts?.attempts ?? 0) >= 5
        ? "Five incorrect codes. This approval challenge was cancelled; run /review to start again."
        : "That code is incorrect or expired. Try the current six-digit code.");
      return;
    }
    const consumed = await env.DB.prepare("UPDATE telegram_connections SET last_totp_step = ? WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active' AND (last_totp_step IS NULL OR last_totp_step < ?)")
      .bind(step, businessId, chatId, userId, step).run();
    if ((consumed.meta?.changes ?? 0) !== 1) {
      await sendTelegramMessage(env, chatId, "That authenticator code has already been used. Wait for the next code.");
      return;
    }
    const origin = await env.DB.prepare("SELECT telegram_chat_id, telegram_user_id FROM telegram_request_origins WHERE operation_id = ? LIMIT 1")
      .bind(pending.operation_id).first<{ telegram_chat_id: string; telegram_user_id: string }>();
    if (origin?.telegram_chat_id !== chatId || origin?.telegram_user_id !== userId) {
      await env.DB.prepare("DELETE FROM telegram_pending_approvals WHERE id = ?").bind(pending.id).run();
      await sendTelegramMessage(env, chatId, "This approval challenge is no longer valid for this requester.");
      return;
    }
    const details = await telegramOperationSnapshot(env, pending.operation_id, businessId);
    const eligible = Boolean(details && details.operation.status === "reserved" && details.operation.action === "direct_fulfillment" &&
      details.snapshotHash === pending.snapshot_hash && details.reservations.some(item => item.status === "active" && Date.parse(item.expires_at) > Date.now()));
    if (!eligible || !details) {
      await env.DB.prepare("DELETE FROM telegram_pending_approvals WHERE id = ?").bind(pending.id).run();
      await sendTelegramMessage(env, chatId, "Request details or reservation changed. Run /review again.");
      return;
    }
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO telegram_operation_approvals (id, business_id, operation_id, decision, snapshot_hash, telegram_chat_id, telegram_user_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind("tap_" + crypto.randomUUID().replaceAll("-", ""), businessId, pending.operation_id, pending.decision, pending.snapshot_hash, chatId, userId).run();
    await env.DB.prepare("DELETE FROM telegram_pending_approvals WHERE id = ?").bind(pending.id).run();
    if ((inserted.meta?.changes ?? 0) !== 1) {
      await sendTelegramMessage(env, chatId, "A decision has already been recorded for this request.");
      return;
    }
    await notifyBusiness(env, businessId, "A Telegram operator " + pending.decision + " their own liquidity request " + pending.operation_id + " using Google Authenticator. No transaction was signed, broadcast or transferred.");
    await sendTelegramMessage(env, chatId, "Request " + pending.decision + ". Authenticator verification succeeded. The decision is recorded; no transaction was signed, broadcast or transferred.");
    return;
  }
  if (command === "/newrequest") {
    if (!canCreateTelegramRequest(connection.permission)) {
      await sendTelegramMessage(env, chatId, "Request creation requires Requester or Approver access. Ask your business administrator to update your Telegram permissions.");
      return;
    }
    await startTelegramLiquidityRequest(env, chatId, userId, businessId);
    return;
  }
  if (command === "/cancel") {
    const cancelled = await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND step != 'submitting'").bind(businessId, chatId, userId).run();
    const active = await env.DB.prepare("SELECT step FROM telegram_request_drafts WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? LIMIT 1").bind(businessId, chatId, userId).first<{ step: string }>();
    await sendTelegramMessage(env, chatId, (cancelled.meta?.changes ?? 0) > 0 ? "Your liquidity request draft has been cancelled." : active && !isTelegramDraftCancellable(active.step) ? "Your confirmed request is already being processed and can no longer be cancelled." : "There is no active request draft to cancel.");
    return;
  }
  if (!command.startsWith("/") && await continueTelegramLiquidityRequest(env, chatId, userId, businessId, rawText)) return;
  if (command === "/start") {
    await sendTelegramMessage(
      env,
      chatId,
      `Welcome back, ${connection.business_name}.\n\nGood to have you back. You can check what's happening in your workspace, keep an eye on liquidity, and manage requests right here.\n\nSend /status for a quick overview, or /help if you need the command list.`,
      telegramSupportMarkup(env)
    );
    return;
  }

  if (command === "/guide") {
    await sendTelegramMessage(env, chatId, "Your NERITH workspace · " + connection.business_name + "\n\nA workspace is your team’s private operating space. It brings your agents, registered business wallets, liquidity requests, permissions and operating limits together. It is not a wallet, and it does not hold funds.\n\nGetting started\n1. Your administrator creates and manages the workspace at https://neritth.pages.dev/control.\n2. Your administrator registers the business’s public operating wallet and configures agent access and limits.\n3. Your administrator connects this Telegram bot and invites team members with private, one-use links.\n4. Each team member opens their invitation in a private chat to link their Telegram account.\n\nUsing NERITH here\n/status  See workspace activity and liquidity\n/agents  Check agent status\n/liquidity  Review available and reserved balances\n/newrequest  Create a liquidity request\n/review  Review prepared requests\n/help  See all commands\n\nA request is not a completed transfer. Telegram records requests and business decisions; it cannot sign or broadcast transactions or move funds.");
    return;
  }

  if (command === "/help" || command === "/commands") {
    await sendTelegramMessage(
      env,
      chatId,
      `NERITH · ${connection.business_name}\n\n/guide  Understand your workspace and setup\n/login  Open the secure business dashboard\n/businessid  Show linked Business ID(s)\n/workspace  Show linked workspace details\n/status  Business overview\n/liquidity  Available and reserved balances\n/forecast  Upcoming planned obligations\n/agents  Agent status\n/operations  Recent liquidity activity\n/newrequest  Create a liquidity request\n/review  Review prepared liquidity requests\n/setupauth  Set up Google Authenticator\n/verifyauth  Verify authenticator setup\n/confirmapproval  Confirm a self-approval\n/cancel  Cancel a request draft\n/disconnect  Disconnect this chat\n\nRequests are checked against authorised, fresh liquidity and reservations. Approvals record a business decision only. This bot cannot sign or broadcast transactions.`,
      telegramSupportMarkup(env)
    );
    return;
  }

  if (command === "/disconnect") {
    await env.DB.prepare(
      "UPDATE telegram_connections SET status = 'disabled' WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active'"
    ).bind(businessId, chatId, userId).run();
    await sendTelegramMessage(env, chatId, "This Telegram chat has been disconnected from NERITH business alerts and commands.");
    return;
  }

  if (command === "/liquidity" || command === "/status") {
    const [balances, agents, operations] = await Promise.all([
      env.DB.prepare(`
        SELECT b.token,
          CAST(SUM(CAST(b.confirmed_atoms AS INTEGER)) AS TEXT) AS confirmed_atoms,
          CAST(SUM(CAST(b.reserved_atoms AS INTEGER)) AS TEXT) AS reserved_atoms,
          MIN(b.observed_at) AS observed_at
        FROM wallets w
        JOIN wallet_balances b ON b.wallet_id = w.id
        WHERE w.business_id = ? AND w.status = 'active' AND w.purpose = 'operating'
        GROUP BY b.token
        ORDER BY b.token
      `).bind(businessId).all<{ token: string; confirmed_atoms: string; reserved_atoms: string; observed_at: string }>(),
      env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM agents WHERE business_id = ?")
        .bind(businessId).first<{ total: number; active: number }>(),
      env.DB.prepare("SELECT COUNT(*) AS pending FROM operations WHERE business_id = ? AND status NOT IN ('settled', 'failed', 'cancelled')")
        .bind(businessId).first<{ pending: number }>()
    ]);
    const balanceLines = (balances.results ?? []).map((row) => {
      const decimals = row.token === "SOL" ? 9 : 6;
      const confirmed = BigInt(row.confirmed_atoms ?? "0");
      const reserved = BigInt(row.reserved_atoms ?? "0");
      const available = confirmed > reserved ? confirmed - reserved : 0n;
      const age = Date.now() - Date.parse(row.observed_at);
      const freshness = Number.isFinite(age) && age >= 0 && age <= 5 * 60 * 1000 ? "fresh" : "stale snapshot";
      return `• ${row.token}: ${formatTokenAmount(available, decimals)} available · ${formatTokenAmount(reserved, decimals)} reserved (${freshness})`;
    });
    const body = command === "/status"
      ? `NERITH · ${connection.business_name}\n\nAgents: ${agents?.active ?? 0}/${agents?.total ?? 0} active\nOpen operations: ${operations?.pending ?? 0}\n\nOperating liquidity:\n${balanceLines.length ? balanceLines.join("\n") : "No operating balance snapshots are available."}\n\nUse /forecast for upcoming obligations.`
      : `Operating liquidity · ${connection.business_name}\n\n${balanceLines.length ? balanceLines.join("\n") : "No operating balance snapshots are available."}\n\nAvailable liquidity is the confirmed balance after internal reservations are deducted.\nBalance snapshots can become outdated. Check freshness before acting.`;
    await sendTelegramMessage(env, chatId, body);
    return;
  }

  if (command === "/forecast") {
    const rows = await env.DB.prepare(`
      SELECT a.name AS agent_name, o.task_id, o.amount_atoms, o.due_at, o.purpose
      FROM liquidity_obligations o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.business_id = ? AND o.status = 'planned'
      ORDER BY o.due_at ASC
      LIMIT 8
    `).bind(businessId).all<{ agent_name: string; task_id: string; amount_atoms: string; due_at: string; purpose: string }>();
    const items = rows.results ?? [];
    const total = await env.DB.prepare("SELECT COUNT(*) AS count FROM liquidity_obligations WHERE business_id = ? AND status = 'planned'")
      .bind(businessId).first<{ count: number }>();
    const lines = items.map((item) =>
      `• ${item.agent_name} · ${formatTokenAmount(BigInt(item.amount_atoms), 6)} USDC\n  ${item.due_at} · ${item.purpose}`
    );
    await sendTelegramMessage(
      env,
      chatId,
      `Planned obligations · ${connection.business_name}\n\n${lines.length ? lines.join("\n") : "No planned obligations recorded."}${(total?.count ?? 0) > items.length ? `\n\nShowing ${items.length} of ${total?.count} planned obligations.` : ""}\n\nThese are recorded plans, not a guarantee that funds are reserved or available.`
    );
    return;
  }

  if (command === "/agents") {
    const rows = await env.DB.prepare(
      "SELECT name, status, created_at FROM agents WHERE business_id = ? ORDER BY created_at DESC LIMIT 12"
    ).bind(businessId).all<{ name: string; status: string; created_at: string }>();
    const agents = rows.results ?? [];
    await sendTelegramMessage(
      env,
      chatId,
      `Agents · ${connection.business_name}\n\n${agents.length ? agents.map((agent) => `• ${agent.name} · ${agent.status === "active" ? "Active" : "Disabled"}`).join("\n") : "No agents have been provisioned."}`
    );
    return;
  }


  if (command === "/review") {
    await listTelegramRequests(env, chatId, userId, businessId, connection.business_name, connection.permission);
    return;
  }

  if (command === "/operations") {
    const rows = await env.DB.prepare(`
      SELECT a.name AS agent_name, o.task_id, o.token, o.amount_atoms, o.status, o.action, o.created_at, o.transaction_hash
      FROM operations o
      JOIN agents a ON a.id = o.agent_id
      WHERE o.business_id = ?
      ORDER BY o.created_at DESC
      LIMIT 8
    `).bind(businessId).all<{ agent_name: string; task_id: string; token: string; amount_atoms: string; status: string; action: string; created_at: string; transaction_hash: string | null }>();
    const operations = rows.results ?? [];
    await sendTelegramMessage(
      env,
      chatId,
      `Recent operations · ${connection.business_name}\n\n${operations.length ? operations.map((operation) => { const tx = operation.transaction_hash ? `\n  Transaction: ${operation.transaction_hash}\n  Solscan: https://solscan.io/tx/${encodeURIComponent(operation.transaction_hash)}` : ""; return `• ${operation.agent_name} · ${formatTokenAmount(BigInt(operation.amount_atoms), operation.token === "SOL" ? 9 : 6)} ${operation.token}\n  ${operation.action} · ${operation.status} · ${operation.created_at}${tx}`; }).join("\n\n") : "No operations recorded yet."}`
    );
    return;
  }

  await sendTelegramMessage(env, chatId, "I don't recognise that command. Send /help to see available commands.");
}


async function telegramOperationSnapshot(env: Env, operationId: string, businessId: string) {
  const operation = await env.DB.prepare(
    "SELECT o.id, o.business_id, o.agent_id, o.task_id, o.network, o.token, o.amount_atoms, o.purpose, o.status, o.action, o.source_wallet_id, o.created_at, a.name AS agent_name FROM operations o JOIN agents a ON a.id = o.agent_id WHERE o.id = ? AND o.business_id = ? LIMIT 1"
  ).bind(operationId, businessId).first<{
    id: string; business_id: string; agent_id: string; task_id: string;
    network: string; token: string; amount_atoms: string; purpose: string;
    status: string; action: string; source_wallet_id: string | null;
    created_at: string; agent_name: string;
  }>();
  if (!operation) return null;
  const reservations = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms, status, expires_at FROM reservations WHERE operation_id = ? ORDER BY id ASC"
  ).bind(operationId).all<{
    id: string; wallet_balance_id: string; amount_atoms: string; status: string; expires_at: string;
  }>();
  const activeReservations = reservations.results ?? [];
  const snapshot = {
    id: operation.id,
    businessId: operation.business_id,
    agentId: operation.agent_id,
    taskId: operation.task_id,
    network: operation.network,
    token: operation.token,
    amountAtoms: operation.amount_atoms,
    purpose: operation.purpose,
    status: operation.status,
    action: operation.action,
    sourceWalletId: operation.source_wallet_id,
    createdAt: operation.created_at,
    reservations: activeReservations.map(item => ({
      id: item.id, walletBalanceId: item.wallet_balance_id,
      amountAtoms: item.amount_atoms, status: item.status, expiresAt: item.expires_at
    }))
  };
  return { operation, reservations: activeReservations, snapshot, snapshotHash: await sha256(JSON.stringify(snapshot)) };
}

async function listTelegramRequests(env: Env, chatId: string, userId: string, businessId: string, businessName: string, permission: string): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT id FROM operations WHERE business_id = ? AND status = 'reserved' AND action = 'direct_fulfillment' ORDER BY created_at ASC LIMIT 10"
  ).bind(businessId).all<{ id: string }>();
  const eligible = [];
  for (const row of rows.results ?? []) {
    const details = await telegramOperationSnapshot(env, row.id, businessId);
    if (!details || !details.reservations.some(item => item.status === "active" && Date.parse(item.expires_at) > Date.now())) continue;
    const existing = await env.DB.prepare(
      "SELECT decision FROM telegram_operation_approvals WHERE operation_id = ? LIMIT 1"
    ).bind(row.id).first<{ decision: string }>();
    if (!existing) eligible.push(details);
  }
  if (!eligible.length) {
    await sendTelegramMessage(env, chatId, "There are no active, prepared liquidity requests waiting for a decision.");
    return;
  }
  for (const details of eligible.slice(0, 5)) {
    const op = details.operation;
    const amount = formatTokenAmount(BigInt(op.amount_atoms), op.token === "SOL" ? 9 : 6);
    const expiry = details.reservations.map(item => item.expires_at).sort()[0];
    const lines = [
      "Prepared liquidity request",
      "",
      "Business: " + businessName,
      "Agent: " + op.agent_name,
      "Task: " + op.task_id,
      "Amount: " + amount + " " + op.token,
      "Network: " + op.network,
      "Purpose: " + op.purpose,
      "Reservation expires: " + expiry,
      "Operation: " + op.id,
      "",
      "This records a business decision only. It does not sign, broadcast or transfer funds."
    ];
    let markup: Record<string, unknown> | undefined;
    const origin = await env.DB.prepare("SELECT telegram_chat_id, telegram_user_id FROM telegram_request_origins WHERE operation_id = ? LIMIT 1").bind(op.id).first<{ telegram_chat_id: string; telegram_user_id: string }>();
    const isRequester = origin?.telegram_chat_id === chatId && origin?.telegram_user_id === userId;
    const auth = isRequester ? await env.DB.prepare("SELECT totp_secret_enc, totp_enabled_at FROM telegram_connections WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active' AND permission = 'approver' LIMIT 1")
      .bind(businessId, chatId, userId).first<{ totp_secret_enc: string | null; totp_enabled_at: string | null }>() : null;
    const canSelfApprove = Boolean(isRequester && auth?.totp_secret_enc && auth?.totp_enabled_at);
    if (canReviewTelegramRequest(permission, origin?.telegram_chat_id, origin?.telegram_user_id, chatId, userId) || canSelfApprove) {
      const approveToken = newSecret("").slice(0, 48);
      const rejectToken = newSecret("").slice(0, 48);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO telegram_approval_actions (token_hash, business_id, operation_id, telegram_chat_id, telegram_user_id, decision, snapshot_hash, expires_at) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)")
          .bind(await sha256(approveToken), businessId, op.id, chatId, userId, details.snapshotHash, expiresAt),
        env.DB.prepare("INSERT INTO telegram_approval_actions (token_hash, business_id, operation_id, telegram_chat_id, telegram_user_id, decision, snapshot_hash, expires_at) VALUES (?, ?, ?, ?, ?, 'rejected', ?, ?)")
          .bind(await sha256(rejectToken), businessId, op.id, chatId, userId, details.snapshotHash, expiresAt)
      ]);
      markup = { inline_keyboard: [[
        { text: "Approve", callback_data: "na:" + approveToken },
        { text: "Reject", callback_data: "nr:" + rejectToken }
      ]] };
    } else if (isRequester && !canSelfApprove) {
      lines.push("", "You submitted this request. Enable Google Authenticator with /setupauth to decide on your own request from this Telegram account.");
    } else {
      lines.push("", "Viewer access only. Ask the business administrator to grant approver permission.");
    }
    await sendTelegramMessage(env, chatId, lines.join("\n"), markup);
  }
}

async function answerTelegramCallback(env: Env, callbackId: string, message: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text: message, show_alert: false })
    });
  } catch {
    // The durable database decision remains authoritative if Telegram acknowledgement fails.
  }
}

async function handleTelegramApprovalCallback(env: Env, callback: {
  id?: string;
  data?: string;
  from?: { id?: number | string };
  message?: { chat?: { id?: number | string; type?: string } };
}): Promise<void> {
  const callbackId = callback.id ?? "";
  const chatId = callback.message?.chat?.id === undefined ? "" : String(callback.message.chat.id);
  const userId = callback.from?.id === undefined ? "" : String(callback.from.id);
  const match = (callback.data ?? "").match(/^(na|nr):([a-f0-9]{48})$/i);
  if (!callbackId || !chatId || !userId || callback.message?.chat?.type !== "private" || !match) {
    if (callbackId) await answerTelegramCallback(env, callbackId, "This action is invalid.");
    return;
  }
  const decision = match[1].toLowerCase() === "na" ? "approved" : "rejected";
  const tokenHash = await sha256(match[2]);
  const action = await env.DB.prepare(
    "SELECT business_id, operation_id, telegram_chat_id, telegram_user_id, decision, snapshot_hash FROM telegram_approval_actions WHERE token_hash = ? AND decision = ? AND telegram_chat_id = ? AND telegram_user_id = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now') LIMIT 1"
  ).bind(tokenHash, decision, chatId, userId).first<{
    business_id: string; operation_id: string; telegram_chat_id: string;
    telegram_user_id: string; decision: string; snapshot_hash: string;
  }>();
  if (!action) {
    await answerTelegramCallback(env, callbackId, "This action has expired or was already used.");
    return;
  }
  const permission = await env.DB.prepare(
    "SELECT id, permission, totp_secret_enc, totp_enabled_at FROM telegram_connections WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active' AND permission = 'approver' LIMIT 1"
  ).bind(action.business_id, chatId, userId).first<{ id: string; permission: string; totp_secret_enc: string | null; totp_enabled_at: string | null }>();
  if (!permission) {
    await answerTelegramCallback(env, callbackId, "Approver permission is no longer active.");
    return;
  }
  const origin = await env.DB.prepare("SELECT telegram_chat_id, telegram_user_id FROM telegram_request_origins WHERE operation_id = ? LIMIT 1").bind(action.operation_id).first<{ telegram_chat_id: string; telegram_user_id: string }>();
  const isOwnRequest = origin?.telegram_chat_id === chatId && origin?.telegram_user_id === userId;
  if (isOwnRequest) {
    if (!permission.totp_secret_enc || !permission.totp_enabled_at || !env.TELEGRAM_TOTP_ENCRYPTION_KEY) {
      await env.DB.prepare("UPDATE telegram_approval_actions SET consumed_at = datetime('now') WHERE token_hash = ?").bind(tokenHash).run();
      await answerTelegramCallback(env, callbackId, "Set up Google Authenticator with /setupauth before deciding on your own request.");
      return;
    }
    await env.DB.prepare("UPDATE telegram_approval_actions SET consumed_at = datetime('now') WHERE token_hash = ? AND consumed_at IS NULL").bind(tokenHash).run();
    const challenge = await env.DB.prepare("INSERT OR IGNORE INTO telegram_pending_approvals (id, business_id, operation_id, telegram_chat_id, telegram_user_id, decision, snapshot_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+5 minutes'))")
      .bind("tpa_" + crypto.randomUUID().replaceAll("-", ""), action.business_id, action.operation_id, chatId, userId, decision, action.snapshot_hash).run();
    if ((challenge.meta?.changes ?? 0) !== 1) {
      await answerTelegramCallback(env, callbackId, "An authenticator challenge is already active for this request.");
      return;
    }
    await env.DB.prepare("UPDATE telegram_approval_actions SET consumed_at = datetime('now') WHERE business_id = ? AND operation_id = ? AND consumed_at IS NULL")
      .bind(action.business_id, action.operation_id).run();
    await answerTelegramCallback(env, callbackId, "Authenticator verification required.");
    await sendTelegramMessage(env, chatId, "Confirm your own request decision\n\nOpen Google Authenticator and send /confirmapproval followed by its current six-digit code. This challenge expires in five minutes; the code can only be used once.");
    return;
  }
  if (!canReviewTelegramRequest(permission.permission, origin?.telegram_chat_id, origin?.telegram_user_id, chatId, userId)) {
    await env.DB.prepare("UPDATE telegram_approval_actions SET consumed_at = datetime('now') WHERE token_hash = ?").bind(tokenHash).run();
    await answerTelegramCallback(env, callbackId, "You are not authorised to review this request.");
    return;
  }
  const details = await telegramOperationSnapshot(env, action.operation_id, action.business_id);
  const eligible = Boolean(details &&
    details.operation.status === "reserved" &&
    details.operation.action === "direct_fulfillment" &&
    details.reservations.some(item => item.status === "active" && Date.parse(item.expires_at) > Date.now()));
  if (!eligible || !details || details.snapshotHash !== action.snapshot_hash) {
    await env.DB.prepare("UPDATE telegram_approval_actions SET consumed_at = datetime('now') WHERE token_hash = ? AND consumed_at IS NULL")
      .bind(tokenHash).run();
    await answerTelegramCallback(env, callbackId, "Request details or reservation changed. Run /review again.");
    return;
  }
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO telegram_operation_approvals (id, business_id, operation_id, decision, snapshot_hash, telegram_chat_id, telegram_user_id) SELECT ?, a.business_id, a.operation_id, a.decision, a.snapshot_hash, a.telegram_chat_id, a.telegram_user_id FROM telegram_approval_actions a WHERE a.token_hash = ? AND a.decision = ? AND a.consumed_at IS NULL AND julianday(a.expires_at) > julianday('now') AND EXISTS (SELECT 1 FROM telegram_connections c WHERE c.business_id = a.business_id AND c.chat_id = a.telegram_chat_id AND c.telegram_user_id = a.telegram_user_id AND c.status = 'active' AND c.permission = 'approver')"
  ).bind("tap_" + crypto.randomUUID().replaceAll("-", ""), tokenHash, decision).run();
  if ((inserted.meta?.changes ?? 0) !== 1) {
    await answerTelegramCallback(env, callbackId, "A decision has already been recorded for this request.");
    return;
  }
  await env.DB.prepare("UPDATE telegram_approval_actions SET consumed_at = datetime('now') WHERE business_id = ? AND operation_id = ? AND consumed_at IS NULL")
    .bind(action.business_id, action.operation_id).run();
  await notifyBusiness(env, action.business_id, "A Telegram approver " + decision + " liquidity request " + action.operation_id + ". The decision is recorded against the exact reserved operation. No transaction was signed, broadcast or transferred.");
  await answerTelegramCallback(env, callbackId, "Request " + decision + ".");
  await sendTelegramMessage(env, chatId,
    "Request " + decision + ". The decision is recorded against the exact reserved operation. No transaction was signed, broadcast or transferred."
  );
}

async function sendTelegramTestAlert(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "telegram_not_configured" }, 409);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string" || !/^biz_[a-f0-9]{32}$/i.test(body.businessId)) {
    return json({ error: "invalid_request", message: "Provide a valid businessId." }, 400);
  }
  const business = await env.DB.prepare("SELECT id, name FROM businesses WHERE id = ?")
    .bind(body.businessId).first<{ id: string; name: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  const connections = await env.DB.prepare(
    "SELECT chat_id FROM telegram_connections WHERE business_id = ? AND status = 'active'"
  ).bind(business.id).all<{ chat_id: string }>();
  const chats = connections.results ?? [];
  if (!chats.length) return json({ error: "telegram_not_linked", message: "Connect a private Telegram chat before sending a test alert." }, 409);
  const ids = chats.map(() => "tn_" + crypto.randomUUID().replaceAll("-", ""));
  const message = "NERITH test alert\n\nYour Telegram connection is working. Business event notifications are enabled for " + business.name + ".\n\nThis is a delivery test only. No liquidity operation or transaction was created.";
  await env.DB.batch(chats.map((chat, index) => env.DB.prepare(`
    INSERT INTO telegram_notification_outbox
      (id, business_id, chat_id, message, status, attempts, next_attempt_at)
    VALUES (?, ?, ?, ?, 'pending', 0, datetime('now'))
  `).bind(ids[index], business.id, chat.chat_id, message)));
  await deliverTelegramOutbox(env);
  const placeholders = ids.map(() => "?").join(",");
  const states = await env.DB.prepare(
    "SELECT status, COUNT(*) AS count FROM telegram_notification_outbox WHERE id IN (" + placeholders + ") GROUP BY status"
  ).bind(...ids).all<{ status: string; count: number }>();
  const result = Object.fromEntries((states.results ?? []).map(row => [row.status, row.count]));
  return json({
    queued: chats.length,
    delivered: result.sent ?? 0,
    pending: result.pending ?? 0,
    failed: result.failed ?? 0,
    message: (result.sent ?? 0) === chats.length
      ? "Test alert delivered to every connected Telegram chat."
      : "Test alert queued. Any delivery failure will be retried automatically."
  }, 202);
}

async function listTelegramConnections(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId");
  if (!businessId) return json({ error: "business_id_required" }, 400);
  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  const rows = await env.DB.prepare(`
    SELECT id, chat_id, telegram_user_id, permission, dashboard_role, status, linked_at
    FROM telegram_connections
    WHERE business_id = ?
    ORDER BY linked_at ASC
  `).bind(businessId).all<{
    id: string; chat_id: string; telegram_user_id: string;
    permission: string; dashboard_role: string; status: string; linked_at: string;
  }>();
  return json({
    businessId,
    connections: (rows.results ?? []).map(row => ({
      id: row.id,
      chatId: row.chat_id,
      telegramUserId: row.telegram_user_id,
      permission: row.permission,
      dashboardRole: row.dashboard_role,
      status: row.status,
      linkedAt: row.linked_at
    }))
  });
}

async function updateTelegramPermission(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string" ||
      typeof body.chatId !== "string" || typeof body.telegramUserId !== "string" ||
      (typeof body.permission !== "string" || !["viewer", "requester", "approver"].includes(body.permission))) {
    return json({ error: "invalid_request", message: "Provide businessId, chatId, telegramUserId and permission=viewer|requester|approver." }, 400);
  }
  const result = await env.DB.prepare(`
    UPDATE telegram_connections SET permission = ?
    WHERE business_id = ? AND chat_id = ? AND telegram_user_id = ? AND status = 'active'
  `).bind(body.permission, body.businessId, body.chatId, body.telegramUserId).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    return json({ error: "active_telegram_connection_not_found" }, 404);
  }
  return json({
    businessId: body.businessId,
    chatId: body.chatId,
    telegramUserId: body.telegramUserId,
    permission: body.permission
  });
}

async function getTelegramWebhookStatus(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  if (!env.TELEGRAM_BOT_TOKEN) return json({ error: "telegram_not_configured" }, 409);

  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
    const payload = await response.json() as {
      ok?: boolean;
      description?: string;
      result?: {
        url?: string;
        pending_update_count?: number;
        last_error_date?: number;
        last_error_message?: string;
        max_connections?: number;
        allowed_updates?: string[];
      };
    };
    if (!response.ok || !payload.ok || !payload.result) {
      return json({ error: "telegram_status_unavailable" }, 502);
    }

    const info = payload.result;
    const expectedUrl = new URL("/v1/telegram/webhook", request.url).toString();
    const lastErrorDate = Number.isFinite(info.last_error_date)
      ? new Date((info.last_error_date as number) * 1000).toISOString()
      : null;
    return json({
      configured: Boolean(info.url),
      endpointMatches: info.url === expectedUrl,
      webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      pendingUpdateCount: Number.isSafeInteger(info.pending_update_count) && (info.pending_update_count as number) >= 0
        ? info.pending_update_count
        : 0,
      hasDeliveryError: Boolean(info.last_error_message),
      lastErrorAt: lastErrorDate,
      maxConnections: Number.isSafeInteger(info.max_connections) ? info.max_connections : null,
      allowedUpdates: Array.isArray(info.allowed_updates)
        ? info.allowed_updates.filter((value): value is string => typeof value === "string")
        : []
    });
  } catch {
    return json({ error: "telegram_status_unavailable" }, 502);
  }
}

async function configureTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({
      error: "telegram_not_configured",
      message: "Set TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET as Worker secrets first."
    }, 409);
  }

  const webhookUrl = new URL("/v1/telegram/webhook", request.url).toString();
  try {
    const identityResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
    const identity = await identityResponse.json() as {
      ok?: boolean;
      result?: { username?: string; first_name?: string };
    };
    if (!identityResponse.ok || !identity.ok || !identity.result?.username) {
      return json({ error: "telegram_bot_authentication_failed" }, 502);
    }

    const webhookResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"]
      })
    });
    const webhook = await webhookResponse.json() as { ok?: boolean; description?: string };
    if (!webhookResponse.ok || !webhook.ok) {
      return json({ error: "telegram_webhook_setup_failed", message: webhook.description ?? "Telegram rejected the webhook configuration." }, 502);
    }

    const nameResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyName`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "NERITH | Liquidity Coordinator" })
    });
    const nameResult = await nameResponse.json() as { ok?: boolean; description?: string };
    if (!nameResponse.ok || !nameResult.ok) {
      return json({ error: "telegram_name_setup_failed", message: nameResult.description ?? "Telegram rejected the bot name." }, 502);
    }

    const shortDescriptionResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyShortDescription`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        short_description: "Liquidity coordination for autonomous agents. Monitor liquidity, funding needs and agent operations with NERITH."
      })
    });
    const shortDescriptionResult = await shortDescriptionResponse.json() as { ok?: boolean; description?: string };
    if (!shortDescriptionResponse.ok || !shortDescriptionResult.ok) {
      return json({ error: "telegram_short_description_setup_failed", message: shortDescriptionResult.description ?? "Telegram rejected the short description." }, 502);
    }

    const commandsResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyCommands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start", description: "Open your NERITH workspace" },
          { command: "help", description: "Explore commands and safety" },
          { command: "guide", description: "Understand your workspace and setup" },
          { command: "businessid", description: "Show linked business IDs" },
          { command: "workspace", description: "View linked workspace details" },
          { command: "status", description: "Business and agent overview" },
          { command: "liquidity", description: "Available and reserved balances" },
          { command: "forecast", description: "Upcoming liquidity obligations" },
          { command: "agents", description: "Connected agent status" },
          { command: "operations", description: "Recent liquidity activity" },
          { command: "newrequest", description: "Create a liquidity request" },
          { command: "review", description: "Review pending requests" },
          { command: "setupauth", description: "Set up Google Authenticator" },
          { command: "verifyauth", description: "Verify authenticator setup" },
          { command: "confirmapproval", description: "Confirm a request decision" },
          { command: "cancel", description: "Cancel an unfinished request" },
          { command: "disconnect", description: "Disconnect this Telegram chat" }
        ]
      })
    });
    const commandResult = await commandsResponse.json() as { ok?: boolean; description?: string };
    if (!commandsResponse.ok || !commandResult.ok) {
      return json({ error: "telegram_commands_setup_failed", message: commandResult.description ?? "Telegram rejected the command list." }, 502);
    }

    const descriptionResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setMyDescription`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        description: "NERITH coordinates business liquidity across autonomous-agent workflows. Monitor available and reserved balances, connected agents, upcoming obligations and recent operations. Create liquidity requests and let authorised business approvers review them. NERITH records business decisions but does not sign or broadcast blockchain transactions or move funds."
      })
    });
    const descriptionResult = await descriptionResponse.json() as { ok?: boolean; description?: string };
    if (!descriptionResponse.ok || !descriptionResult.ok) {
      return json({ error: "telegram_description_setup_failed", message: descriptionResult.description ?? "Telegram rejected the bot description." }, 502);
    }

    return json({
      configured: true,
      botUsername: identity.result.username,
      webhookUrl,
      commands: ["start", "help", "guide", "businessid", "workspace", "status", "liquidity", "forecast", "agents", "operations", "newrequest", "review", "setupauth", "verifyauth", "confirmapproval", "cancel", "disconnect"],
      supportLinkConfigured: Boolean(telegramSupportMarkup(env))
    });
  } catch {
    return json({ error: "telegram_setup_unavailable" }, 502);
  }
}

async function telegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !(await constantTimeEqual(secret, supplied))) return json({ error: "unauthorized" }, 401);
  const update = await readJson(request.clone());
  if (!update) return json({ error: "invalid_update" }, 400);
  const updateId = update.update_id;
  if (!(typeof updateId === "number" && Number.isSafeInteger(updateId) && updateId >= 0)) {
    return json({ error: "invalid_update_id" }, 400);
  }
  const id = String(updateId);
  const claim = await env.DB.prepare("INSERT OR IGNORE INTO telegram_processed_updates (update_id) VALUES (?)")
    .bind(id).run();
  if ((claim.meta?.changes ?? 0) !== 1) {
    const existing = await env.DB.prepare("SELECT status, locked_until FROM telegram_processed_updates WHERE update_id = ?")
      .bind(id).first<{ status: string; locked_until: string }>();
    if (existing?.status === "completed" ||
        (existing?.status === "processing" && existing.locked_until > new Date().toISOString().replace("T", " ").slice(0, 19))) {
      return json({ ok: true, duplicate: true });
    }
    const reclaimed = await env.DB.prepare(`
      UPDATE telegram_processed_updates
      SET status = 'processing', locked_until = datetime('now', '+2 minutes'), processed_at = datetime('now')
      WHERE update_id = ? AND (status != 'processing' OR locked_until <= datetime('now'))
    `).bind(id).run();
    if ((reclaimed.meta?.changes ?? 0) !== 1) return json({ ok: true, duplicate: true });
  }
  try {
    const response = await processTelegramWebhook(request, env);
    if (response.ok) {
      await env.DB.prepare("UPDATE telegram_processed_updates SET status = 'completed', locked_until = datetime('now') WHERE update_id = ?")
        .bind(id).run();
    } else {
      await env.DB.prepare("DELETE FROM telegram_processed_updates WHERE update_id = ? AND status = 'processing'")
        .bind(id).run();
    }
    return response;
  } catch (error) {
    await env.DB.prepare("DELETE FROM telegram_processed_updates WHERE update_id = ? AND status = 'processing'")
      .bind(id).run();
    throw error;
  }
}

async function processTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  const supplied = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !(await constantTimeEqual(secret, supplied))) return json({ error: "unauthorized" }, 401);

  const update = await readJson(request);
  if (!update) return json({ error: "invalid_update" }, 400);
  const callback = update.callback_query as {
    id?: string;
    data?: string;
    from?: { id?: number | string };
    message?: { chat?: { id?: number | string; type?: string } };
  } | undefined;
  if (callback) {
    await handleTelegramApprovalCallback(env, callback);
    return json({ ok: true });
  }
  const message = update.message as {
    text?: string;
    chat?: { id?: number | string; type?: string };
    from?: { id?: number | string };
  } | undefined;
  const text = message?.text ?? "";
  const chatId = message?.chat?.id === undefined ? "" : String(message.chat.id);
  const userId = message?.from?.id === undefined ? "" : String(message.from.id);
  const match = text.match(/^\/(?:start|link)\s+([a-f0-9]{64})$/i);

  if (!chatId || !userId || message?.chat?.type !== "private") {
    return json({ ok: true });
  }

  if (!match) {
    await handleTelegramCommand(env, chatId, userId, text);
    return json({ ok: true });
  }

  const codeHash = await sha256(match[1]);
  const linkCode = await env.DB.prepare(
    "SELECT id, business_id, dashboard_role FROM telegram_link_codes WHERE code_hash = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')"
  ).bind(codeHash).first<{ id: string; business_id: string; dashboard_role: string }>();
  if (!linkCode) {
    await sendTelegramMessage(env, chatId, "That invitation is invalid or expired. Ask your business administrator for a new one.");
    return json({ ok: true });
  }

  const existingConnection = await env.DB.prepare(
    "SELECT business_id FROM telegram_connections WHERE chat_id = ? AND telegram_user_id = ? AND status = 'active' LIMIT 1"
  ).bind(chatId, userId).first<{ business_id: string }>();
  if (existingConnection && existingConnection.business_id !== linkCode.business_id) {
    await sendTelegramMessage(env, chatId, "This Telegram account is already linked to another NERITH business. Send /disconnect in that business chat before linking a different business.");
    return json({ ok: true });
  }

  const claim = await env.DB.prepare(
    "UPDATE telegram_link_codes SET consumed_at = datetime('now') WHERE id = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')"
  ).bind(linkCode.id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return json({ ok: true });

  try {
    await env.DB.prepare(
      "INSERT INTO telegram_connections (id, business_id, chat_id, telegram_user_id, permission, dashboard_role) VALUES (?, ?, ?, ?, 'approver', ?) ON CONFLICT(business_id, chat_id, telegram_user_id) DO UPDATE SET status = 'active', permission = 'approver', dashboard_role = excluded.dashboard_role"
    ).bind("tg_" + crypto.randomUUID().replaceAll("-", ""), linkCode.business_id, chatId, userId, linkCode.dashboard_role).run();
  } catch {
    await env.DB.prepare("UPDATE telegram_link_codes SET consumed_at = NULL WHERE id = ?")
      .bind(linkCode.id).run();
    await sendTelegramMessage(env, chatId, "We couldn't finish linking this chat. Please try the invitation again.");
    return json({ ok: true });
  }

  await sendTelegramMessage(env, chatId, "Your Telegram chat is now connected to your NERITH workspace.\n\nStart with /status for a business overview, /liquidity for available and reserved balances, or /forecast for upcoming obligations. Use /newrequest to submit a liquidity request and /review to review prepared requests.\n\nUse /login to open the secure business dashboard, or /help for the full command list. NERITH records business decisions but never signs or broadcasts blockchain transactions or moves funds.");
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


async function listBusinessWallets(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  if (!businessId) return json({ error: "business_id_required" }, 400);
  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  const rows = await env.DB.prepare(`
    SELECT w.id, w.address, w.network, w.scope, w.purpose, w.status,
           w.ownership_verified_at, w.ownership_verified_origin,
           b.token, b.confirmed_atoms, b.reserved_atoms, b.observed_at, b.source
    FROM wallets w
    LEFT JOIN wallet_balances b ON b.wallet_id = w.id
    WHERE w.business_id = ?
    ORDER BY w.status ASC, w.purpose ASC, w.address ASC, b.token ASC
  `).bind(businessId).all<{
    id: string; address: string; network: string; scope: string; purpose: string; status: string;
    ownership_verified_at: string | null; ownership_verified_origin: string | null;
    token: string | null; confirmed_atoms: string | null; reserved_atoms: string | null;
    observed_at: string | null; source: string | null;
  }>();
  const wallets = new Map<string, {
    walletId: string; address: string; network: string; scope: string; purpose: string; status: string;
    ownershipVerifiedAt: string | null; ownershipVerifiedOrigin: string | null;
    balances: Array<{ token: string; confirmed: string; reserved: string; available: string; observedAt: string; source: string; fresh: boolean }>;
  }>();
  for (const row of rows.results ?? []) {
    if (!wallets.has(row.id)) wallets.set(row.id, {
      walletId: row.id, address: row.address, network: row.network, scope: row.scope,
      purpose: row.purpose, status: row.status, ownershipVerifiedAt: row.ownership_verified_at, ownershipVerifiedOrigin: row.ownership_verified_origin, balances: []
    });
    if (row.token && row.confirmed_atoms !== null && row.reserved_atoms !== null && row.observed_at && row.source) {
      const decimals = row.token === "SOL" ? 9 : 6;
      const confirmed = BigInt(row.confirmed_atoms);
      const reserved = BigInt(row.reserved_atoms);
      const ageMs = Date.now() - Date.parse(row.observed_at);
      wallets.get(row.id)!.balances.push({
        token: row.token,
        confirmed: formatTokenAmount(confirmed, decimals),
        reserved: formatTokenAmount(reserved, decimals),
        available: formatTokenAmount(confirmed > reserved ? confirmed - reserved : 0n, decimals),
        observedAt: row.observed_at,
        source: row.source,
        fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60 * 1000
      });
    }
  }
  return json({ businessId, wallets: [...wallets.values()] });
}


function parsePolicyArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(item => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function isSqliteAtomString(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return false;
  return BigInt(value) <= 9_223_372_036_854_775_807n;
}

type BusinessPaymentPolicyRow = {
  business_id: string;
  allowed_mints: string;
  allowed_destinations: string;
  allowed_conversion_mints: string;
  max_transaction_atoms: string;
  max_network_fee_lamports: string;
  allowed_fee_payer_wallet_ids: string;
  max_daily_atoms: string;
  max_balance_age_seconds: number;
  max_intent_lifetime_seconds: number;
  max_slippage_bps: number;
  allow_conversion: number;
  allow_partial_payment: number;
  version: number;
  updated_at: string;
};

function toPaymentPolicy(row: BusinessPaymentPolicyRow, committedTodayAtoms: bigint): PaymentPolicy {
  return {
    businessId: row.business_id,
    allowedMints: parsePolicyArray(row.allowed_mints),
    allowedDestinations: parsePolicyArray(row.allowed_destinations),
    allowedConversionMints: parsePolicyArray(row.allowed_conversion_mints),
    maxTransactionAtoms: row.max_transaction_atoms,
    maxNetworkFeeLamports: row.max_network_fee_lamports,
    allowedFeePayerWalletIds: parsePolicyArray(row.allowed_fee_payer_wallet_ids),
    maxDailyAtoms: row.max_daily_atoms,
    committedTodayAtoms: committedTodayAtoms.toString(),
    maxBalanceAgeSeconds: row.max_balance_age_seconds,
    maxIntentLifetimeSeconds: row.max_intent_lifetime_seconds,
    maxSlippageBps: row.max_slippage_bps,
    allowConversion: row.allow_conversion === 1,
    allowPartialPayment: row.allow_partial_payment === 1
  };
}

async function getBusinessPaymentPolicy(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId");
  if (!businessId) return json({ error: "business_id_required" }, 400);
  const row = await env.DB.prepare("SELECT * FROM business_payment_policies WHERE business_id = ? LIMIT 1")
    .bind(businessId).first<BusinessPaymentPolicyRow>();
  if (!row) return json({ businessId, policy: null });
  return json({
    businessId,
    policy: {
      allowedMints: parsePolicyArray(row.allowed_mints),
      allowedDestinations: parsePolicyArray(row.allowed_destinations),
      allowedConversionMints: parsePolicyArray(row.allowed_conversion_mints),
      maxTransactionAtoms: row.max_transaction_atoms,
      maxNetworkFeeLamports: row.max_network_fee_lamports,
      allowedFeePayerWalletIds: parsePolicyArray(row.allowed_fee_payer_wallet_ids),
      maxDailyAtoms: row.max_daily_atoms,
      maxBalanceAgeSeconds: row.max_balance_age_seconds,
      maxIntentLifetimeSeconds: row.max_intent_lifetime_seconds,
      maxSlippageBps: row.max_slippage_bps,
      allowConversion: row.allow_conversion === 1,
      allowPartialPayment: row.allow_partial_payment === 1,
      version: row.version,
      updatedAt: row.updated_at
    }
  });
}

async function setBusinessPaymentPolicy(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);
  const {
    businessId, allowedMints, allowedDestinations, allowedConversionMints,
    maxTransactionAtoms, maxNetworkFeeLamports, allowedFeePayerWalletIds,
    maxDailyAtoms, maxBalanceAgeSeconds, maxIntentLifetimeSeconds,
    maxSlippageBps, allowConversion, allowPartialPayment
  } = body;
  const validStringArray = (value: unknown, min: number, max: number, itemMax: number) =>
    Array.isArray(value) && value.length >= min && value.length <= max &&
    value.every(item => typeof item === "string" && item.length > 0 && item.length <= itemMax) &&
    new Set(value).size === value.length;
  if (
    typeof businessId !== "string" || !businessId ||
    !validStringArray(allowedMints, 1, 10, 128) ||
    !validStringArray(allowedDestinations, 1, 100, 128) ||
    !validStringArray(allowedConversionMints, 0, 10, 128) ||
    !validStringArray(allowedFeePayerWalletIds, 1, 20, 128) ||
    !isSqliteAtomString(maxTransactionAtoms) ||
    !isSqliteAtomString(maxNetworkFeeLamports) && maxNetworkFeeLamports !== "0" ||
    !isSqliteAtomString(maxDailyAtoms) ||
    !Number.isSafeInteger(maxBalanceAgeSeconds) || (maxBalanceAgeSeconds as number) < 1 || (maxBalanceAgeSeconds as number) > 86400 ||
    !Number.isSafeInteger(maxIntentLifetimeSeconds) || (maxIntentLifetimeSeconds as number) < 60 || (maxIntentLifetimeSeconds as number) > 86400 ||
    !Number.isSafeInteger(maxSlippageBps) || (maxSlippageBps as number) < 0 || (maxSlippageBps as number) > 10000 ||
    typeof allowConversion !== "boolean" || typeof allowPartialPayment !== "boolean"
  ) return json({ error: "invalid_payment_policy", message: "Provide explicit allowlists, bounded atom limits, balance freshness, intent lifetime, slippage and policy flags." }, 400);

  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  const feePayerIds = allowedFeePayerWalletIds as string[];
  const placeholders = feePayerIds.map(() => "?").join(",");
  const eligibleFeePayers = await env.DB.prepare(`
    SELECT DISTINCT w.id
    FROM wallets w
    JOIN wallet_role_assignments r ON r.wallet_id = w.id AND r.business_id = w.business_id
    WHERE w.business_id = ? AND w.scope = 'business' AND w.network = 'solana'
      AND w.status = 'active' AND w.ownership_verified_at IS NOT NULL
      AND r.enabled = 1 AND r.role IN ('payment', 'operating')
      AND w.id IN (${placeholders})
  `).bind(businessId, ...feePayerIds).all<{ id: string }>();
  if ((eligibleFeePayers.results ?? []).length !== feePayerIds.length) {
    return json({ error: "invalid_fee_payer_allowlist", message: "Every fee payer must be a verified, active business payment or operating wallet." }, 409);
  }

  await env.DB.prepare(`
    INSERT INTO business_payment_policies (
      business_id, allowed_mints, allowed_destinations, allowed_conversion_mints,
      max_transaction_atoms, max_network_fee_lamports, allowed_fee_payer_wallet_ids,
      max_daily_atoms, max_balance_age_seconds, max_intent_lifetime_seconds,
      max_slippage_bps, allow_conversion, allow_partial_payment, version, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(business_id) DO UPDATE SET
      allowed_mints = excluded.allowed_mints,
      allowed_destinations = excluded.allowed_destinations,
      allowed_conversion_mints = excluded.allowed_conversion_mints,
      max_transaction_atoms = excluded.max_transaction_atoms,
      max_network_fee_lamports = excluded.max_network_fee_lamports,
      allowed_fee_payer_wallet_ids = excluded.allowed_fee_payer_wallet_ids,
      max_daily_atoms = excluded.max_daily_atoms,
      max_balance_age_seconds = excluded.max_balance_age_seconds,
      max_intent_lifetime_seconds = excluded.max_intent_lifetime_seconds,
      max_slippage_bps = excluded.max_slippage_bps,
      allow_conversion = excluded.allow_conversion,
      allow_partial_payment = excluded.allow_partial_payment,
      version = business_payment_policies.version + 1,
      updated_at = datetime('now')
  `).bind(
    businessId, JSON.stringify(allowedMints), JSON.stringify(allowedDestinations),
    JSON.stringify(allowedConversionMints), maxTransactionAtoms, maxNetworkFeeLamports,
    JSON.stringify(feePayerIds), maxDailyAtoms, maxBalanceAgeSeconds,
    maxIntentLifetimeSeconds, maxSlippageBps, allowConversion ? 1 : 0,
    allowPartialPayment ? 1 : 0
  ).run();
  const saved = await env.DB.prepare("SELECT version, updated_at FROM business_payment_policies WHERE business_id = ?")
    .bind(businessId).first<{ version: number; updated_at: string }>();
  return json({ businessId, saved: true, version: saved?.version ?? 1, updatedAt: saved?.updated_at ?? null }, 200);
}

async function createBusinessPaymentIntent(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  if (agent.can_use_business_treasury !== 1) return json({ error: "business_treasury_permission_required" }, 403);
  const limited = await enforceAgentRateLimit(env, agent.id, "payment_prepare", 10, 60);
  if (limited) return limited;
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);
  const { taskId, idempotencyKey, destination, feePayerWalletId } = body;
  const mint = typeof body.mint === "string" ? body.mint : (env.SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const networkFeeLamports = typeof body.networkFeeLamports === "string" ? body.networkFeeLamports : "";
  const allowPartialPayment = body.allowPartialPayment === true;
  const slippageBps = body.slippageBps === undefined ? null : body.slippageBps;
  const purpose = typeof body.purpose === "string" ? body.purpose.trim() : "Business payment";
  if (
    typeof taskId !== "string" || !/^[a-zA-Z0-9._:-]{1,100}$/.test(taskId) ||
    typeof idempotencyKey !== "string" || !/^[a-zA-Z0-9._:-]{8,128}$/.test(idempotencyKey) ||
    typeof destination !== "string" || !destination || destination.length > 128 ||
    typeof feePayerWalletId !== "string" || !feePayerWalletId ||
    mint !== (env.SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") ||
    !/^(0|[1-9][0-9]{0,18})$/.test(networkFeeLamports) ||
    BigInt(networkFeeLamports || "0") > 9_223_372_036_854_775_807n ||
    (slippageBps !== null && (!Number.isSafeInteger(slippageBps) || (slippageBps as number) < 0 || (slippageBps as number) > 10000)) ||
    purpose.length > 300
  ) return json({ error: "invalid_payment_request" }, 400);

  try { decodeSolanaAddress(destination); }
  catch { return json({ error: "invalid_solana_destination", message: "Destination must be a valid 32-byte Solana public key." }, 400); }

  let requestedAtoms: bigint;
  try { requestedAtoms = parseTokenAmount(body.amount); }
  catch (error) { return json({ error: "invalid_amount", message: error instanceof Error ? error.message : "Invalid amount" }, 400); }

  const existingIntent = await env.DB.prepare(`
    SELECT i.id, i.operation_id, i.destination, i.mint, i.requested_atoms, i.fee_payer_wallet_id,
           i.network_fee_lamports, i.allow_partial_payment, i.slippage_bps,
           i.action, i.status, op.task_id
    FROM business_payment_intents i
    JOIN operations op ON op.id = i.operation_id
    WHERE i.business_id = ? AND i.idempotency_key = ?
    LIMIT 1
  `).bind(agent.business_id, idempotencyKey).first<{
    id: string; operation_id: string; destination: string; mint: string;
    requested_atoms: string; fee_payer_wallet_id: string; network_fee_lamports: string;
    allow_partial_payment: number; slippage_bps: number | null; action: string; status: string; task_id: string;
  }>();
  if (existingIntent) {
    const sameRequest = existingIntent.destination === destination && existingIntent.mint === mint &&
      existingIntent.requested_atoms === requestedAtoms.toString() &&
      existingIntent.fee_payer_wallet_id === feePayerWalletId &&
      existingIntent.network_fee_lamports === networkFeeLamports &&
      existingIntent.allow_partial_payment === (allowPartialPayment ? 1 : 0) &&
      existingIntent.slippage_bps === (slippageBps as number | null) &&
      existingIntent.task_id === taskId;
    if (!sameRequest) return json({ error: "idempotency_key_conflict" }, 409);
    return json({
      intentId: existingIntent.id, operationId: existingIntent.operation_id,
      action: existingIntent.action, status: existingIntent.status, reused: true
    });
  }

  const duplicateTask = await env.DB.prepare("SELECT id FROM operations WHERE agent_id = ? AND task_id = ? LIMIT 1")
    .bind(agent.id, taskId).first<{ id: string }>();
  if (duplicateTask) return json({ error: "duplicate_task", existingOperationId: duplicateTask.id }, 409);

  const policyRow = await env.DB.prepare("SELECT * FROM business_payment_policies WHERE business_id = ? LIMIT 1")
    .bind(agent.business_id).first<BusinessPaymentPolicyRow>();
  if (!policyRow) return json({ error: "payment_policy_not_configured" }, 409);

  const walletRows = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.business_id, w.scope, w.status,
           w.ownership_verified_at, w.address, r.role, r.enabled,
           r.minimum_remaining_atoms, r.maximum_transfer_atoms,
           b.id AS balance_id, b.token, b.confirmed_atoms, b.reserved_atoms, b.observed_at
    FROM wallets w
    JOIN wallet_role_assignments r ON r.wallet_id = w.id AND r.business_id = w.business_id
    JOIN wallet_balances b ON b.wallet_id = w.id
    WHERE w.business_id = ? AND w.network = 'solana'
      AND r.enabled = 1 AND r.role IN ('payment', 'reserve', 'operating')
  `).bind(agent.business_id).all<{
    wallet_id: string; business_id: string; scope: string; status: string;
    ownership_verified_at: string | null; address: string; role: string; enabled: number;
    minimum_remaining_atoms: string; maximum_transfer_atoms: string | null;
    balance_id: string; token: string; confirmed_atoms: string; reserved_atoms: string; observed_at: string;
  }>();
  const usdcMint = env.SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const snapshots: PolicyWalletSnapshot[] = (walletRows.results ?? []).map(row => ({
    walletId: row.wallet_id, businessId: row.business_id, scope: row.scope,
    status: row.status, role: row.role as PolicyWalletSnapshot["role"], enabled: row.enabled === 1,
    ownershipVerifiedAt: row.ownership_verified_at,
    mint: row.token === "USDC" ? usdcMint : row.token === "SOL" ? "SOL" : row.token,
    confirmedAtoms: row.confirmed_atoms, reservedAtoms: row.reserved_atoms,
    observedAt: row.observed_at, minimumRemainingAtoms: row.minimum_remaining_atoms,
    maximumTransferAtoms: row.maximum_transfer_atoms
  }));
  const committedRows = await env.DB.prepare(`
    SELECT payment_atoms FROM business_payment_intents
    WHERE business_id = ? AND created_at >= date('now')
      AND status IN ('reserved', 'replenishing', 'awaiting_owner_approval', 'awaiting_signature', 'submitted', 'confirmed', 'ambiguous')
  `).bind(agent.business_id).all<{ payment_atoms: string }>();
  const committedTodayAtoms = (committedRows.results ?? []).reduce((sum, row) => sum + BigInt(row.payment_atoms), 0n);
  const policy = toPaymentPolicy(policyRow, committedTodayAtoms);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.maxIntentLifetimeSeconds * 1000);
  const intent: PaymentIntent = {
    operationId: "pending",
    idempotencyKey,
    idempotencyKeyAlreadyUsed: false,
    businessId: agent.business_id,
    destination,
    mint,
    amountAtoms: requestedAtoms.toString(),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    allowPartialPayment,
    slippageBps: slippageBps as number | null,
    networkFeeLamports,
    networkFeePayerWalletId: feePayerWalletId
  };
  const decision = evaluatePaymentIntentPolicy(intent, policy, snapshots, now.getTime());
  if (!decision.eligible) return json({ error: decision.code, message: decision.message }, 409);

  const operationId = makeOperationId();
  const paymentIntentId = "bpi_" + crypto.randomUUID().replaceAll("-", "");
  const paymentAtoms = decision.action === "conversion_required"
    ? decision.policyPermittedAtoms
    : decision.paymentAmountAtoms;
  const paymentWalletRow = (walletRows.results ?? []).find(row =>
    row.wallet_id === decision.paymentWalletId && row.token === "USDC" && row.role === "payment"
  );
  if (!paymentWalletRow) return json({ error: "payment_wallet_balance_missing" }, 409);

  const replenishmentLegs = decision.action === "conversion_required"
    ? []
    : decision.replenishmentPlan.legs;
  const needsReplenishment = replenishmentLegs.length > 0;
  const paymentAction = decision.action;
  const intentStatus = decision.action === "conversion_required"
    ? "awaiting_owner_approval"
    : needsReplenishment ? "replenishing" : "reserved";
  const operationStatus = decision.action === "conversion_required"
    ? "awaiting_conversion" : "reserved";
  const conversionSourceWalletId = decision.action === "conversion_required"
    ? decision.conversionSourceWallets[0]?.walletId ?? null : null;
  const operationShortfall = decision.action === "conversion_required"
    ? decision.conversionShortfallAtoms
    : decision.replenishmentPlan.shortfallAtoms;
  const finalLegId = "leg_" + crypto.randomUUID().replaceAll("-", "");
  const finalLegAmount = paymentAtoms.toString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO operations
        (id, business_id, agent_id, task_id, network, token, amount_atoms, purpose,
         status, action, available_atoms, shortfall_atoms, source_wallet_id)
      VALUES (?, ?, ?, ?, 'solana', 'USDC', ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      operationId, agent.business_id, agent.id, taskId, requestedAtoms.toString(),
      purpose, operationStatus, paymentAction, decision.paymentWalletAvailableAtoms.toString(),
      operationShortfall.toString(), conversionSourceWalletId
    ),
    env.DB.prepare(`
      INSERT INTO business_payment_intents (
        id, business_id, operation_id, idempotency_key, destination, mint,
        requested_atoms, payment_atoms, fee_payer_wallet_id, network_fee_lamports,
        allow_partial_payment, slippage_bps, action, status, policy_version, policy_snapshot, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      paymentIntentId, agent.business_id, operationId, idempotencyKey, destination, mint,
      requestedAtoms.toString(), paymentAtoms.toString(), feePayerWalletId, networkFeeLamports,
      allowPartialPayment ? 1 : 0, slippageBps, paymentAction, intentStatus, policyRow.version,
      JSON.stringify({ ...policy, committedTodayAtoms: committedTodayAtoms.toString() }),
      expiresAt.toISOString()
    )
  ];

  const reservationDetails: Array<{ id: string; fundingLegId: string | null; walletId: string; token: string; amountAtoms: string }> = [];
  if (decision.action !== "conversion_required" && BigInt(networkFeeLamports) > 0n) {
    const feePayerWalletRow = (walletRows.results ?? []).find(row =>
      row.wallet_id === feePayerWalletId && row.token === "SOL" &&
      (row.role === "payment" || row.role === "operating")
    );
    if (!feePayerWalletRow) return json({ error: "network_fee_balance_missing" }, 409);
    const feeReservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
    statements.push(env.DB.prepare(`
      INSERT INTO reservations
        (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES (?, ?, ?, ?, 'SOL', 'active', ?, NULL, 'managed_fee')
    `).bind(feeReservationId, operationId, feePayerWalletRow.balance_id, networkFeeLamports, expiresAt.toISOString()));
    reservationDetails.push({ id: feeReservationId, fundingLegId: null, walletId: feePayerWalletId, token: "SOL", amountAtoms: networkFeeLamports });
  }
  const fundingLegDetails: Array<{ id: string; kind: string; sourceWalletId: string; destinationWalletId: string | null; amountAtoms: string; status: string }> = [];
  for (const [index, planLeg] of replenishmentLegs.entries()) {
    const sourceRow = (walletRows.results ?? []).find(row =>
      row.wallet_id === planLeg.sourceWalletId && row.token === "USDC" &&
      (row.role === "reserve" || row.role === "operating")
    );
    if (!sourceRow || !paymentWalletRow.address) return json({ error: "replenishment_wallet_snapshot_missing" }, 409);
    const legId = "leg_" + crypto.randomUUID().replaceAll("-", "");
    const reservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
    const amountAtoms = planLeg.amountAtoms.toString();
    statements.push(env.DB.prepare(`
      INSERT INTO operation_funding_legs
        (id, operation_id, leg_index, kind, source_wallet_id, destination_wallet_id,
         destination_address, asset_mint, amount_atoms, status)
      VALUES (?, ?, ?, 'reserve_replenishment', ?, ?, ?, ?, ?, 'planned')
    `).bind(legId, operationId, index, planLeg.sourceWalletId, decision.paymentWalletId,
      paymentWalletRow.address, mint, amountAtoms));
    statements.push(env.DB.prepare(`
      INSERT INTO reservations
        (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
      VALUES (?, ?, ?, ?, 'USDC', 'active', ?, ?, 'managed')
    `).bind(reservationId, operationId, sourceRow.balance_id, amountAtoms, expiresAt.toISOString(), legId));
    statements.push(env.DB.prepare("UPDATE operation_funding_legs SET status = 'reserved' WHERE id = ?").bind(legId));
    reservationDetails.push({ id: reservationId, fundingLegId: legId, walletId: planLeg.sourceWalletId, token: "USDC", amountAtoms });
    fundingLegDetails.push({ id: legId, kind: "reserve_replenishment", sourceWalletId: planLeg.sourceWalletId, destinationWalletId: decision.paymentWalletId, amountAtoms, status: "reserved" });
  }

  if (decision.action !== "conversion_required") {
    statements.push(env.DB.prepare(`
      INSERT INTO operation_funding_legs
        (id, operation_id, leg_index, kind, source_wallet_id, destination_address, asset_mint, amount_atoms, status)
      VALUES (?, ?, ?, 'final_payment', ?, ?, ?, ?, 'planned')
    `).bind(finalLegId, operationId, replenishmentLegs.length, decision.paymentWalletId, destination, mint, finalLegAmount));
    if (!needsReplenishment) {
      statements.push(env.DB.prepare("UPDATE operation_funding_legs SET status = 'reserved' WHERE id = ?").bind(finalLegId));
      const paymentReservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
      statements.push(env.DB.prepare(`
        INSERT INTO reservations
          (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
        VALUES (?, ?, ?, ?, 'USDC', 'active', ?, ?, 'managed')
      `).bind(paymentReservationId, operationId, paymentWalletRow.balance_id, finalLegAmount, expiresAt.toISOString(), finalLegId));
      reservationDetails.push({ id: paymentReservationId, fundingLegId: finalLegId, walletId: decision.paymentWalletId, token: "USDC", amountAtoms: finalLegAmount });
    } else if (decision.paymentWalletAvailableAtoms > 0n) {
      const prepositionReservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
      const prepositionAtoms = decision.paymentWalletAvailableAtoms.toString();
      statements.push(env.DB.prepare(`
        INSERT INTO reservations
          (id, operation_id, wallet_balance_id, amount_atoms, token, status, expires_at, funding_leg_id, reservation_source)
        VALUES (?, ?, ?, ?, 'USDC', 'active', ?, NULL, 'managed')
      `).bind(prepositionReservationId, operationId, paymentWalletRow.balance_id, prepositionAtoms, expiresAt.toISOString()));
      reservationDetails.push({ id: prepositionReservationId, fundingLegId: null, walletId: decision.paymentWalletId, token: "USDC", amountAtoms: prepositionAtoms });
    }
    fundingLegDetails.push({ id: finalLegId, kind: "final_payment", sourceWalletId: decision.paymentWalletId, destinationWalletId: null, amountAtoms: finalLegAmount, status: needsReplenishment ? "planned" : "reserved" });
  }

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const existing = await env.DB.prepare(`
      SELECT i.id, i.operation_id, i.destination, i.mint, i.requested_atoms, i.fee_payer_wallet_id,
             i.network_fee_lamports, i.allow_partial_payment, i.slippage_bps,
             i.action, i.status, op.task_id
      FROM business_payment_intents i JOIN operations op ON op.id = i.operation_id
      WHERE i.business_id = ? AND i.idempotency_key = ? LIMIT 1
    `).bind(agent.business_id, idempotencyKey).first<{ id: string; operation_id: string; destination: string; mint: string; requested_atoms: string; fee_payer_wallet_id: string; network_fee_lamports: string; allow_partial_payment: number; slippage_bps: number | null; action: string; status: string; task_id: string }>();
    if (existing && existing.destination === destination && existing.mint === mint &&
        existing.requested_atoms === requestedAtoms.toString() && existing.fee_payer_wallet_id === feePayerWalletId &&
        existing.network_fee_lamports === networkFeeLamports &&
        existing.allow_partial_payment === (allowPartialPayment ? 1 : 0) &&
        existing.slippage_bps === (slippageBps as number | null) && existing.task_id === taskId) {
      return json({ intentId: existing.id, operationId: existing.operation_id, action: existing.action, status: existing.status, reused: true });
    }
    return json({ error: "payment_intent_persistence_failed", message: error instanceof Error ? error.message : String(error) }, 409);
  }

  return json({
    intentId: paymentIntentId,
    operationId,
    status: intentStatus,
    action: paymentAction,
    requestedAtoms: requestedAtoms.toString(),
    paymentAtoms: paymentAtoms.toString(),
    fundingLegs: fundingLegDetails,
    reservations: reservationDetails,
    ownerApprovalRequired: decision.ownerApprovalRequired,
    note: decision.action === "conversion_required"
      ? "Conversion requires explicit owner approval. No conversion or final-payment transaction has been prepared."
      : needsReplenishment
        ? "Reserve-wallet amounts are held in the internal ledger. Final payment remains blocked until every replenishment leg is confirmed."
        : "The payment-wallet amount is held in the internal ledger. No transaction has been signed or broadcast."
  }, 201);
}


async function prepareFinalPaymentAfterReplenishment(
  request: Request, env: Env, intentId: string
): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
  if (!businessId) return json({ error: "business_id_required" }, 400);
  if (!env.SOLANA_RPC_URL) return json({ error: "solana_rpc_not_configured" }, 503);

  const row = await env.DB.prepare(`
    SELECT i.id AS intent_id, i.status AS intent_status, i.action, i.expires_at,
           i.payment_atoms, i.mint, op.id AS operation_id,
           final_leg.id AS final_leg_id, final_leg.status AS final_leg_status,
           payment_wallet.id AS payment_wallet_id, payment_wallet.address AS payment_wallet_address,
           payment_wallet.status AS payment_wallet_status, payment_wallet.scope AS payment_wallet_scope,
           payment_wallet.ownership_verified_at,
           balance.id AS balance_id, balance.reserved_atoms,
           (SELECT role.minimum_remaining_atoms FROM wallet_role_assignments role
            WHERE role.business_id = i.business_id AND role.wallet_id = payment_wallet.id
              AND role.role = 'payment' AND role.enabled = 1 LIMIT 1) AS payment_minimum_remaining_atoms,
           (SELECT role.maximum_transfer_atoms FROM wallet_role_assignments role
            WHERE role.business_id = i.business_id AND role.wallet_id = payment_wallet.id
              AND role.role = 'payment' AND role.enabled = 1 LIMIT 1) AS payment_maximum_transfer_atoms,
           EXISTS (
             SELECT 1 FROM wallet_role_assignments role
             WHERE role.business_id = i.business_id AND role.wallet_id = payment_wallet.id
               AND role.role = 'payment' AND role.enabled = 1
           ) AS payment_role_authorized,
           (SELECT COUNT(*) FROM operation_funding_legs funding
            WHERE funding.operation_id = op.id AND funding.kind = 'reserve_replenishment') AS reserve_leg_count,
           (SELECT COUNT(*) FROM operation_funding_legs funding
            WHERE funding.operation_id = op.id AND funding.kind = 'reserve_replenishment'
              AND funding.status = 'confirmed') AS confirmed_reserve_leg_count,
           (SELECT COUNT(*) FROM operation_funding_legs funding
            WHERE funding.operation_id = op.id AND funding.kind = 'conversion') AS conversion_leg_count
    FROM business_payment_intents i
    JOIN operations op ON op.id = i.operation_id AND op.business_id = i.business_id
    JOIN operation_funding_legs final_leg ON final_leg.operation_id = op.id AND final_leg.kind = 'final_payment'
    JOIN wallets payment_wallet ON payment_wallet.id = final_leg.source_wallet_id
    JOIN wallet_balances balance ON balance.wallet_id = payment_wallet.id AND balance.token = 'USDC'
    WHERE i.id = ? AND i.business_id = ?
    LIMIT 1
  `).bind(intentId, businessId).first<{
    intent_id: string; intent_status: string; action: string; expires_at: string;
    payment_atoms: string; mint: string; operation_id: string;
    final_leg_id: string; final_leg_status: string;
    payment_wallet_id: string; payment_wallet_address: string;
    payment_wallet_status: string; payment_wallet_scope: string;
    ownership_verified_at: string | null; balance_id: string; reserved_atoms: string;
    payment_minimum_remaining_atoms: string | null; payment_maximum_transfer_atoms: string | null;
    payment_role_authorized: number; reserve_leg_count: number;
    confirmed_reserve_leg_count: number; conversion_leg_count: number;
  }>();
  if (!row) return json({ error: "payment_intent_not_found" }, 404);
  if (row.action === "replenish_then_pay" && row.intent_status === "awaiting_signature" &&
      row.final_leg_status === "reserved") {
    const existingReservation = await env.DB.prepare(`
      SELECT id FROM reservations
      WHERE funding_leg_id = ? AND reservation_source = 'managed' AND status = 'active'
      LIMIT 1
    `).bind(row.final_leg_id).first<{ id: string }>();
    if (existingReservation) {
      return json({
        intentId,
        status: "awaiting_signature",
        finalPaymentLegId: row.final_leg_id,
        reservationId: existingReservation.id,
        reused: true,
        note: "The finalized payment-wallet balance has already been refreshed and the final-payment amount is reserved."
      });
    }
  }
  if (row.action !== "replenish_then_pay" || row.intent_status !== "replenishing") {
    return json({ error: "payment_intent_not_waiting_for_replenishment", status: row.intent_status }, 409);
  }
  if (Date.parse(row.expires_at) <= Date.now()) return json({ error: "payment_intent_expired" }, 409);
  if (row.reserve_leg_count < 1 || row.confirmed_reserve_leg_count !== row.reserve_leg_count || row.conversion_leg_count > 0) {
    return json({
      error: "reserve_replenishment_not_fully_confirmed",
      confirmedReserveLegs: row.confirmed_reserve_leg_count,
      totalReserveLegs: row.reserve_leg_count
    }, 409);
  }
  if (row.final_leg_status !== "planned" || row.payment_wallet_status !== "active" ||
      row.payment_wallet_scope !== "business" || !row.ownership_verified_at ||
      row.payment_role_authorized !== 1) {
    return json({ error: "final_payment_wallet_or_leg_not_authorized" }, 409);
  }

  const mint = env.SOLANA_USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  if (row.mint !== mint) return json({ error: "final_payment_mint_not_supported" }, 409);
  let balance: { amountAtoms: string; commitment: "finalized" };
  try {
    balance = await fetchFinalizedSplTokenBalance(
      env.SOLANA_RPC_URL, row.payment_wallet_address, mint, 6
    );
  } catch {
    return json({
      intentId,
      status: "replenishing",
      pending: true,
      error: "finalized_payment_wallet_balance_unavailable",
      message: "Reserve transfers are confirmed, but NERITH could not obtain a finalized payment-wallet balance. No final-payment reservation was created."
    }, 503);
  }

  const prepositionRows = await env.DB.prepare(`
    SELECT amount_atoms FROM reservations
    WHERE operation_id = ? AND wallet_balance_id = ? AND funding_leg_id IS NULL
      AND reservation_source = 'managed' AND status = 'active'
  `).bind(row.operation_id, row.balance_id).all<{ amount_atoms: string }>();
  const prepositionAtoms = (prepositionRows.results ?? [])
    .reduce((sum, reservation) => sum + BigInt(reservation.amount_atoms), 0n);
  const currentlyReservedAtoms = BigInt(row.reserved_atoms);
  if (prepositionAtoms > currentlyReservedAtoms) {
    return json({ error: "payment_wallet_reservation_ledger_mismatch" }, 409);
  }
  const reservedAfterPrepositionRelease = currentlyReservedAtoms - prepositionAtoms;
  const finalizedAtoms = BigInt(balance.amountAtoms);
  const spendableAfterRefresh = finalizedAtoms > reservedAfterPrepositionRelease
    ? finalizedAtoms - reservedAfterPrepositionRelease : 0n;
  const minimumRemainingAtoms = BigInt(row.payment_minimum_remaining_atoms ?? "0");
  const maximumTransferAtoms = row.payment_maximum_transfer_atoms
    ? BigInt(row.payment_maximum_transfer_atoms) : 9_223_372_036_854_775_807n;
  if (BigInt(row.payment_atoms) > maximumTransferAtoms ||
      spendableAfterRefresh < BigInt(row.payment_atoms) + minimumRemainingAtoms) {
    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE wallet_balances
          SET confirmed_atoms = ?, observed_at = datetime('now'), source = 'solana_rpc_finalized'
          WHERE id = ? AND wallet_id = ? AND token = 'USDC'
        `).bind(balance.amountAtoms, row.balance_id, row.payment_wallet_id),
        env.DB.prepare(`
          UPDATE reservations SET status = 'released', released_at = datetime('now')
          WHERE operation_id = ? AND wallet_balance_id = ? AND funding_leg_id IS NULL
            AND reservation_source = 'managed' AND status = 'active'
        `).bind(row.operation_id, row.balance_id)
      ]);
    } catch {
      return json({ error: "payment_wallet_balance_refresh_conflict" }, 409);
    }
    return json({
      intentId,
      status: "replenishing",
      error: "finalized_payment_wallet_balance_insufficient",
      finalizedUSDCBalanceAtoms: balance.amountAtoms,
      spendableAfterExistingReservationsAtoms: spendableAfterRefresh.toString(),
      requiredPaymentAtoms: row.payment_atoms,
      minimumRemainingAtoms: minimumRemainingAtoms.toString(),
      note: "The finalized balance snapshot was refreshed and the temporary preposition hold released, but the payment amount plus required reserve floor is not available. The final-payment leg remains blocked."
    }, 409);
  }

  const reservationId = "res_" + crypto.randomUUID().replaceAll("-", "");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      UPDATE business_payment_intents SET status = 'awaiting_signature', updated_at = datetime('now')
      WHERE id = ? AND business_id = ? AND status = 'replenishing'
    `).bind(intentId, businessId),
    env.DB.prepare(`
      UPDATE wallet_balances
      SET confirmed_atoms = ?, observed_at = datetime('now'), source = 'solana_rpc_finalized'
      WHERE id = ? AND wallet_id = ? AND token = 'USDC'
    `).bind(balance.amountAtoms, row.balance_id, row.payment_wallet_id),
    env.DB.prepare(`
      UPDATE reservations SET status = 'released', released_at = datetime('now')
      WHERE operation_id = ? AND wallet_balance_id = ? AND funding_leg_id IS NULL
        AND reservation_source = 'managed' AND status = 'active'
    `).bind(row.operation_id, row.balance_id),
    env.DB.prepare(`
      UPDATE operation_funding_legs SET status = 'reserved', updated_at = datetime('now')
      WHERE id = ? AND operation_id = ? AND kind = 'final_payment' AND status = 'planned'
    `).bind(row.final_leg_id, row.operation_id),
    env.DB.prepare(`
      INSERT INTO reservations
        (id, operation_id, wallet_balance_id, amount_atoms, token, status,
         expires_at, funding_leg_id, reservation_source)
      VALUES (?, ?, ?, ?, 'USDC', 'active', ?, ?, 'managed')
    `).bind(reservationId, row.operation_id, row.balance_id, row.payment_atoms, row.expires_at, row.final_leg_id)
  ];
  try {
    const results = await env.DB.batch(statements);
    for (const index of [0, 1, 3, 4]) {
      if ((results[index]?.meta?.changes ?? 0) !== 1) {
        return json({ error: "final_payment_preparation_conflict" }, 409);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("managed_reservation_insufficient_balance")) {
      return json({
        error: "finalized_payment_wallet_balance_insufficient",
        finalizedBalanceAtoms: balance.amountAtoms,
        requiredPaymentAtoms: row.payment_atoms,
        message: "Finalized USDC balance is insufficient after preserving existing active reservations and wallet reserve floors."
      }, 409);
    }
    return json({ error: "final_payment_preparation_conflict" }, 409);
  }

  return json({
    intentId,
    status: "awaiting_signature",
    finalPaymentLegId: row.final_leg_id,
    paymentWalletId: row.payment_wallet_id,
    finalizedUSDCBalanceAtoms: balance.amountAtoms,
    paymentAtoms: row.payment_atoms,
    reservationId,
    commitment: balance.commitment,
    note: "Every reserve transfer is finalized and verified. The payment wallet balance was refreshed at finalized commitment and the final-payment amount is now reserved. No transaction has been signed or broadcast."
  }, 200);
}

type FundingLegSettlementRow = {
  leg_id: string; leg_status: string; leg_kind: string; transaction_hash: string | null;
  amount_atoms: string; asset_mint: string; destination_address: string;
  intent_id: string; intent_status: string; intent_action: string; intent_expires_at: string;
  intent_destination: string; intent_mint: string; payment_atoms: string;
  operation_id: string; business_id: string; operation_status: string;
  source_wallet_id: string; source_address: string; source_status: string;
  source_scope: string; source_verified_at: string | null;
  destination_wallet_id: string | null; destination_wallet_address: string | null;
  destination_wallet_status: string | null; destination_wallet_scope: string | null;
  destination_verified_at: string | null; reservation_id: string | null;
  source_role_authorized: number; destination_role_authorized: number;
  fee_payer_address: string | null; fee_payer_wallet_status: string | null;
  fee_payer_verified_at: string | null; fee_payer_scope: string | null;
  fee_payer_role_authorized: number; network_fee_lamports: string;
  fee_reservation_id: string | null;
};

async function getFundingLegSettlementRow(
  env: Env, intentId: string, legId: string, businessId: string
): Promise<FundingLegSettlementRow | null> {
  return env.DB.prepare(`
    SELECT l.id AS leg_id, l.status AS leg_status, l.kind AS leg_kind,
           l.transaction_hash, l.amount_atoms, l.asset_mint, l.destination_address,
           i.id AS intent_id, i.status AS intent_status, i.action AS intent_action,
           i.expires_at AS intent_expires_at, i.destination AS intent_destination,
           i.mint AS intent_mint, i.payment_atoms, i.network_fee_lamports,
           fee_wallet.address AS fee_payer_address,
           fee_wallet.status AS fee_payer_wallet_status,
           fee_wallet.ownership_verified_at AS fee_payer_verified_at,
           fee_wallet.scope AS fee_payer_scope,
           EXISTS (
             SELECT 1 FROM wallet_role_assignments fee_role
             WHERE fee_role.business_id = op.business_id AND fee_role.wallet_id = fee_wallet.id
               AND fee_role.enabled = 1 AND fee_role.role IN ('payment', 'operating')
           ) AS fee_payer_role_authorized,
           op.id AS operation_id, op.business_id, op.status AS operation_status,
           source_wallet.id AS source_wallet_id, source_wallet.address AS source_address,
           source_wallet.status AS source_status, source_wallet.scope AS source_scope,
           source_wallet.ownership_verified_at AS source_verified_at,
           CASE WHEN l.kind = 'final_payment' THEN EXISTS (
             SELECT 1 FROM wallet_role_assignments role
             WHERE role.business_id = op.business_id AND role.wallet_id = source_wallet.id
               AND role.role = 'payment' AND role.enabled = 1
           ) ELSE EXISTS (
             SELECT 1 FROM wallet_role_assignments role
             WHERE role.business_id = op.business_id AND role.wallet_id = source_wallet.id
               AND role.role IN ('reserve', 'operating') AND role.enabled = 1
           ) END AS source_role_authorized,
           destination_wallet.id AS destination_wallet_id,
           destination_wallet.address AS destination_wallet_address,
           destination_wallet.status AS destination_wallet_status,
           destination_wallet.scope AS destination_wallet_scope,
           destination_wallet.ownership_verified_at AS destination_verified_at,
           CASE WHEN l.kind = 'reserve_replenishment' THEN EXISTS (
             SELECT 1 FROM wallet_role_assignments role
             WHERE role.business_id = op.business_id AND role.wallet_id = destination_wallet.id
               AND role.role = 'payment' AND role.enabled = 1
           ) ELSE 1 END AS destination_role_authorized,
           reservation.id AS reservation_id,
           fee_reservation.id AS fee_reservation_id
    FROM operation_funding_legs l
    JOIN operations op ON op.id = l.operation_id
    JOIN business_payment_intents i ON i.operation_id = op.id AND i.business_id = op.business_id
    JOIN wallets source_wallet ON source_wallet.id = l.source_wallet_id
    JOIN wallets fee_wallet ON fee_wallet.id = i.fee_payer_wallet_id
    LEFT JOIN wallets destination_wallet ON destination_wallet.id = l.destination_wallet_id
    LEFT JOIN reservations reservation
      ON reservation.funding_leg_id = l.id AND reservation.status = 'active'
    LEFT JOIN reservations fee_reservation
      ON fee_reservation.operation_id = op.id AND fee_reservation.reservation_source = 'managed_fee' AND fee_reservation.status = 'active'
    WHERE i.id = ? AND l.id = ? AND op.business_id = ?
    LIMIT 1
  `).bind(intentId, legId, businessId).first<FundingLegSettlementRow>();
}

async function submitFundingLegTransaction(
  request: Request, env: Env, intentId: string, legId: string
): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
  const body = await readJson(request);
  if (!body || typeof body.signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(body.signature)) {
    return json({ error: "invalid_transaction_signature" }, 400);
  }
  const row = await getFundingLegSettlementRow(env, intentId, legId, businessId);
  if (!row) return json({ error: "funding_leg_not_found" }, 404);
  if (row.leg_status === "submitted" && row.transaction_hash === body.signature) {
    return json({ intentId, fundingLegId: legId, status: "submitted", reused: true,
      note: "Signature is recorded only; on-chain settlement is still unverified." });
  }
  if (row.transaction_hash) return json({ error: "funding_leg_signature_already_bound" }, 409);
  if (row.intent_action === "conversion_required" || row.leg_kind === "conversion") {
    return json({ error: "conversion_settlement_not_supported" }, 409);
  }
  if (Date.parse(row.intent_expires_at) <= Date.now()) return json({ error: "payment_intent_expired" }, 409);
  if (row.intent_status !== "reserved" && row.intent_status !== "replenishing" && row.intent_status !== "awaiting_signature") {
    return json({ error: "payment_intent_not_submittable", status: row.intent_status }, 409);
  }
  if (row.leg_status !== "reserved" && row.leg_status !== "awaiting_signature" &&
      row.leg_status !== "authorized_for_execution") {
    return json({ error: "funding_leg_not_submittable", status: row.leg_status }, 409);
  }
  if (!row.reservation_id || row.source_status !== "active" || row.source_scope !== "business" || !row.source_verified_at || row.source_role_authorized !== 1) {
    return json({ error: "funding_leg_reservation_or_source_invalid" }, 409);
  }
  if (row.leg_kind === "reserve_replenishment" &&
      (!row.destination_wallet_id || row.destination_wallet_status !== "active" ||
       row.destination_wallet_scope !== "business" || !row.destination_verified_at ||
       row.destination_role_authorized !== 1 || row.destination_address !== row.destination_wallet_address)) {
    return json({ error: "funding_leg_destination_wallet_invalid" }, 409);
  }
  if (row.leg_kind === "final_payment" &&
      (row.destination_address !== row.intent_destination ||
       row.asset_mint !== row.intent_mint || row.amount_atoms !== row.payment_atoms)) {
    return json({ error: "funding_leg_intent_identity_mismatch" }, 409);
  }

  const statements: D1PreparedStatement[] = [];
  if (row.leg_status === "reserved") {
    statements.push(env.DB.prepare(
      "UPDATE operation_funding_legs SET status = 'awaiting_signature' WHERE id = ? AND status = 'reserved' AND transaction_hash IS NULL"
    ).bind(legId));
  }
  statements.push(env.DB.prepare(`
    UPDATE operation_funding_legs
    SET transaction_hash = ?, status = 'submitted', updated_at = datetime('now')
    WHERE id = ? AND operation_id = ? AND status = ? AND transaction_hash IS NULL
      AND EXISTS (
        SELECT 1 FROM reservations r
        WHERE r.funding_leg_id = operation_funding_legs.id AND r.status = 'active'
      )
  `).bind(body.signature, legId, row.operation_id,
    row.leg_status === "reserved" ? "awaiting_signature" : row.leg_status));
  if (row.leg_kind === "final_payment") {
    statements.push(env.DB.prepare(`
      UPDATE business_payment_intents SET status = 'submitted', updated_at = datetime('now')
      WHERE id = ? AND business_id = ? AND status IN ('reserved', 'awaiting_signature')
    `).bind(intentId, businessId));
  }
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "funding_leg_submission_conflict" }, 409);
  }
  const updated = await getFundingLegSettlementRow(env, intentId, legId, businessId);
  if (!updated || updated.leg_status !== "submitted" || updated.transaction_hash !== body.signature) {
    return json({ error: "funding_leg_submission_conflict" }, 409);
  }
  return json({ intentId, fundingLegId: legId, status: "submitted", transactionSignature: body.signature,
    note: "Signature recorded. NERITH has not yet verified finality or payment settlement." }, 202);
}

async function reconcileFundingLegTransaction(
  request: Request, env: Env, intentId: string, legId: string
): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId") ?? "";
  const row = await getFundingLegSettlementRow(env, intentId, legId, businessId);
  if (!row) return json({ error: "funding_leg_not_found" }, 404);
  if (row.leg_status === "confirmed") {
    return json({ intentId, fundingLegId: legId, status: "confirmed", confirmed: true, reused: true });
  }
  if (row.leg_status === "ambiguous") {
    // Ambiguous finalized mismatches are not automatically retried or released.
    return json({ intentId, fundingLegId: legId, status: "ambiguous", confirmed: false,
      note: "The finalized transaction did not prove the approved transfer. Reservations remain held for owner review." }, 409);
  }
  if (row.leg_status !== "submitted" || !row.transaction_hash) {
    return json({ error: "funding_leg_not_submitted", status: row.leg_status }, 409);
  }
  if (!env.SOLANA_RPC_URL) return json({ error: "solana_rpc_not_configured" }, 503);
  if (row.intent_action === "conversion_required" || row.leg_kind === "conversion") {
    return json({ error: "conversion_settlement_not_supported" }, 409);
  }
  if (!row.reservation_id || row.source_status !== "active" || row.source_scope !== "business" || !row.source_verified_at || row.source_role_authorized !== 1) {
    return json({ error: "funding_leg_reservation_or_source_invalid" }, 409);
  }
  const destinationOwner = row.leg_kind === "reserve_replenishment"
    ? row.destination_wallet_address : row.destination_address;
  if (!destinationOwner || (row.leg_kind === "reserve_replenishment" &&
      (!row.destination_wallet_id || row.destination_wallet_status !== "active" ||
       row.destination_wallet_scope !== "business" || !row.destination_verified_at ||
       row.destination_role_authorized !== 1 || row.destination_address !== row.destination_wallet_address))) {
    return json({ error: "funding_leg_destination_invalid" }, 409);
  }
  if (row.leg_kind === "final_payment" &&
      (row.destination_address !== row.intent_destination ||
       row.asset_mint !== row.intent_mint || row.amount_atoms !== row.payment_atoms)) {
    return json({ error: "funding_leg_intent_identity_mismatch" }, 409);
  }

  let lookup;
  try {
    lookup = await fetchFinalizedSolanaTransaction(env.SOLANA_RPC_URL, row.transaction_hash);
  } catch {
    return json({ intentId, fundingLegId: legId, status: "submitted", confirmed: false,
      pending: true, reason: "Solana RPC is temporarily unavailable. The reservation remains active." }, 503);
  }
  if (lookup.state === "pending") {
    return json({ intentId, fundingLegId: legId, status: "submitted", confirmed: false,
      pending: true, reason: lookup.reason }, 202);
  }
  if (lookup.state === "failed") {
    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE operation_funding_legs SET status = 'failed', failure_reason = ?, confirmed_slot = ?,
            updated_at = datetime('now')
          WHERE id = ? AND status = 'submitted' AND transaction_hash = ?
        `).bind(lookup.reason, lookup.slot ?? null, legId, row.transaction_hash),
        env.DB.prepare(`
          UPDATE reservations SET status = 'released', released_at = datetime('now')
          WHERE funding_leg_id = ? AND status = 'active'
        `).bind(legId),
        env.DB.prepare(`
          UPDATE business_payment_intents SET status = 'failed', updated_at = datetime('now')
          WHERE id = ? AND status IN ('submitted', 'replenishing', 'reserved')
        `).bind(intentId)
      ]);
    } catch {
      return json({ error: "funding_leg_failure_reconciliation_conflict" }, 409);
    }
    return json({ intentId, fundingLegId: legId, status: "failed", confirmed: false, reason: lookup.reason }, 409);
  }

  let actualNetworkFee: string | null = null;
  if (row.leg_kind === "final_payment") {
    const feeVerification = verifySolanaNetworkFee(
      lookup.transaction,
      row.fee_payer_address ?? "",
      row.network_fee_lamports
    );
    const feeInvalid = !feeVerification.verified ||
      row.fee_payer_wallet_status !== "active" || row.fee_payer_scope !== "business" ||
      !row.fee_payer_verified_at || row.fee_payer_role_authorized !== 1 ||
      (BigInt(row.network_fee_lamports) > 0n && !row.fee_reservation_id);
    if (feeInvalid) {
      const reason = feeVerification.verified
        ? "Registered fee wallet is no longer active, verified, correctly scoped or assigned, or its fee reservation is missing."
        : feeVerification.reason;
      try {
        await env.DB.batch([
          env.DB.prepare(`
            UPDATE operation_funding_legs SET status = 'ambiguous', failure_reason = ?,
              confirmed_slot = ?, updated_at = datetime('now')
            WHERE id = ? AND status = 'submitted' AND transaction_hash = ?
          `).bind(reason, lookup.slot, legId, row.transaction_hash),
          env.DB.prepare(`
            UPDATE business_payment_intents SET status = 'ambiguous', updated_at = datetime('now')
            WHERE id = ? AND status = 'submitted'
          `).bind(intentId)
        ]);
      } catch {
        return json({ error: "funding_leg_ambiguity_record_failed" }, 409);
      }
      return json({ intentId, fundingLegId: legId, status: "ambiguous", confirmed: false, reason }, 409);
    }
    actualNetworkFee = feeVerification.actualFeeLamports;
  }
  const verification = verifySolanaTokenTransfer(
    lookup.transaction as SolanaPaymentTransaction,
    {
      signature: row.transaction_hash,
      sourceWalletAddress: row.source_address,
      destinationOwnerAddress: destinationOwner,
      mint: row.asset_mint,
      amountAtoms: row.amount_atoms,
      decimals: 6
    }
  );
  if (!verification.verified) {
    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE operation_funding_legs
          SET status = 'ambiguous', failure_reason = ?, confirmed_slot = ?,
              updated_at = datetime('now')
          WHERE id = ? AND status = 'submitted' AND transaction_hash = ?
        `).bind(verification.reason, lookup.slot, legId, row.transaction_hash),
        env.DB.prepare(`
          UPDATE business_payment_intents SET status = 'ambiguous', updated_at = datetime('now')
          WHERE id = ? AND status IN ('submitted', 'replenishing')
        `).bind(intentId)
      ]);
    } catch {
      return json({ error: "funding_leg_ambiguity_record_failed" }, 409);
    }
    return json({ intentId, fundingLegId: legId, status: "ambiguous", confirmed: false,
      reason: verification.reason,
      note: "The transaction is finalized but does not prove the approved transfer. Reservations remain held." }, 409);
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      UPDATE operation_funding_legs
      SET status = 'confirmed', received_output_atoms = ?, confirmed_slot = ?,
          failure_reason = NULL, updated_at = datetime('now')
      WHERE id = ? AND status = 'submitted' AND transaction_hash = ?
    `).bind(verification.amountAtoms ?? row.amount_atoms, lookup.slot, legId, row.transaction_hash),
    env.DB.prepare(`
      UPDATE reservations SET status = 'consumed', released_at = datetime('now')
      WHERE funding_leg_id = ? AND status = 'active'
    `).bind(legId)
  ];
  if (row.leg_kind === "final_payment") {
    if (row.fee_reservation_id) {
      statements.push(env.DB.prepare(`
        UPDATE reservations SET status = 'consumed', released_at = datetime('now')
        WHERE id = ? AND reservation_source = 'managed_fee' AND status = 'active'
      `).bind(row.fee_reservation_id));
    }
    statements.push(env.DB.prepare(`
      UPDATE business_payment_intents SET status = 'confirmed', updated_at = datetime('now')
      WHERE id = ? AND business_id = ? AND status = 'submitted'
    `).bind(intentId, businessId));
    statements.push(env.DB.prepare(`
      UPDATE operations SET status = 'completed' WHERE id = ? AND status = 'reserved'
    `).bind(row.operation_id));
  }
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "funding_leg_confirmation_conflict" }, 409);
  }
  const finalRow = await getFundingLegSettlementRow(env, intentId, legId, businessId);
  if (!finalRow || finalRow.leg_status !== "confirmed") {
    return json({ error: "funding_leg_confirmation_conflict" }, 409);
  }
  return json({
    intentId, fundingLegId: legId, status: "confirmed", confirmed: true,
    transactionSignature: row.transaction_hash, confirmedSlot: lookup.slot,
    amountAtoms: verification.amountAtoms,
    actualNetworkFeeLamports: actualNetworkFee ?? undefined,
    nextStep: row.leg_kind === "reserve_replenishment"
      ? "Refresh and verify the payment-wallet USDC balance at finalized commitment before reserving or submitting the final-payment leg."
      : "Payment transfer and the separately reserved SOL network fee are finalized and reconciled."
  });
}

async function getBusinessPaymentIntent(request: Request, env: Env, intentId: string): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const limited = await enforceAgentRateLimit(env, agent.id, "payment_read", 60, 60);
  if (limited) return limited;
  const intent = await env.DB.prepare(`
    SELECT i.id, i.operation_id, i.destination, i.mint, i.requested_atoms, i.payment_atoms,
           i.fee_payer_wallet_id, i.network_fee_lamports, i.action, i.status,
           i.policy_version, i.expires_at, i.created_at, i.updated_at
    FROM business_payment_intents i
    JOIN operations op ON op.id = i.operation_id AND op.business_id = i.business_id
    WHERE i.id = ? AND i.business_id = ? AND op.agent_id = ?
    LIMIT 1
  `).bind(intentId, agent.business_id, agent.id).first<{
    id: string; operation_id: string; destination: string; mint: string;
    requested_atoms: string; payment_atoms: string; fee_payer_wallet_id: string;
    network_fee_lamports: string; action: string; status: string; policy_version: number;
    expires_at: string; created_at: string; updated_at: string;
  }>();
  if (!intent) return json({ error: "payment_intent_not_found" }, 404);
  const [legs, reservations] = await Promise.all([
    env.DB.prepare(`
      SELECT l.id, l.leg_index, l.kind, l.source_wallet_id, source_wallet.address AS source_address,
             l.destination_wallet_id, destination_wallet.address AS destination_wallet_address,
             l.destination_address, l.asset_mint, l.amount_atoms, l.expected_output_atoms,
             l.received_output_atoms, l.status, l.transaction_hash, l.submitted_slot,
             l.confirmed_slot, l.failure_reason, l.created_at, l.updated_at
      FROM operation_funding_legs l
      LEFT JOIN wallets source_wallet ON source_wallet.id = l.source_wallet_id
      LEFT JOIN wallets destination_wallet ON destination_wallet.id = l.destination_wallet_id
      WHERE l.operation_id = ? ORDER BY l.leg_index ASC
    `).bind(intent.operation_id).all(),
    env.DB.prepare(`
      SELECT r.id, r.funding_leg_id, r.wallet_balance_id, b.wallet_id, w.address AS wallet_address,
             r.amount_atoms, r.token, r.status, r.expires_at, r.reservation_source
      FROM reservations r
      JOIN wallet_balances b ON b.id = r.wallet_balance_id
      JOIN wallets w ON w.id = b.wallet_id
      WHERE r.operation_id = ? ORDER BY r.created_at ASC
    `).bind(intent.operation_id).all()
  ]);
  return json({
    intentId: intent.id, operationId: intent.operation_id, action: intent.action, status: intent.status,
    destination: intent.destination, mint: intent.mint, requestedAtoms: intent.requested_atoms,
    paymentAtoms: intent.payment_atoms, feePayerWalletId: intent.fee_payer_wallet_id,
    networkFeeLamports: intent.network_fee_lamports, policyVersion: intent.policy_version,
    expiresAt: intent.expires_at, createdAt: intent.created_at, updatedAt: intent.updated_at,
    fundingLegs: (legs.results ?? []).map(row => ({
      id: row.id, index: row.leg_index, kind: row.kind, sourceWalletId: row.source_wallet_id,
      sourceAddress: row.source_address, destinationWalletId: row.destination_wallet_id,
      destinationWalletAddress: row.destination_wallet_address, destinationAddress: row.destination_address,
      assetMint: row.asset_mint, amountAtoms: row.amount_atoms, expectedOutputAtoms: row.expected_output_atoms,
      receivedOutputAtoms: row.received_output_atoms, status: row.status, transactionHash: row.transaction_hash,
      submittedSlot: row.submitted_slot, confirmedSlot: row.confirmed_slot, failureReason: row.failure_reason,
      createdAt: row.created_at, updatedAt: row.updated_at
    })),
    reservations: (reservations.results ?? []).map(row => ({
      id: row.id, fundingLegId: row.funding_leg_id, walletId: row.wallet_id, walletAddress: row.wallet_address,
      amountAtoms: row.amount_atoms, token: row.token, status: row.status, expiresAt: row.expires_at,
      source: row.reservation_source
    }))
  });
}
async function listBusinessWalletRoles(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const businessId = new URL(request.url).searchParams.get("businessId");
  if (!businessId) return json({ error: "business_id_required" }, 400);
  const rows = await env.DB.prepare(`
    SELECT r.wallet_id, r.role, r.enabled, r.priority,
           r.minimum_remaining_atoms, r.maximum_transfer_atoms,
           r.created_at, r.updated_at
    FROM wallet_role_assignments r
    JOIN wallets w ON w.id = r.wallet_id AND w.business_id = r.business_id
    WHERE r.business_id = ?
    ORDER BY r.role ASC, r.priority ASC, r.wallet_id ASC
  `).bind(businessId).all<{
    wallet_id: string; role: string; enabled: number; priority: number;
    minimum_remaining_atoms: string; maximum_transfer_atoms: string | null;
    created_at: string; updated_at: string;
  }>();
  return json({
    businessId,
    roles: (rows.results ?? []).map(row => ({
      walletId: row.wallet_id, role: row.role, enabled: row.enabled === 1,
      priority: row.priority, minimumRemainingAtoms: row.minimum_remaining_atoms,
      maximumTransferAtoms: row.maximum_transfer_atoms,
      createdAt: row.created_at, updatedAt: row.updated_at
    }))
  });
}

async function setBusinessWalletRole(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);
  const { businessId, walletId, role } = body;
  const validRoles = ["payment", "reserve", "operating", "receiving", "api_payment"];
  const enabled = body.enabled === undefined ? true : body.enabled;
  const priority = body.priority === undefined ? 100 : body.priority;
  const minimumRemainingAtoms = body.minimumRemainingAtoms === undefined ? "0" : body.minimumRemainingAtoms;
  const maximumTransferAtoms = body.maximumTransferAtoms === undefined ? null : body.maximumTransferAtoms;
  if (
    typeof businessId !== "string" || typeof walletId !== "string" ||
    typeof role !== "string" || !validRoles.includes(role) ||
    typeof enabled !== "boolean" ||
    !Number.isSafeInteger(priority) || (priority as number) < 0 || (priority as number) > 1_000_000 ||
    typeof minimumRemainingAtoms !== "string" ||
    !(minimumRemainingAtoms === "0" || isSqliteAtomString(minimumRemainingAtoms)) ||
    (maximumTransferAtoms !== null && (typeof maximumTransferAtoms !== "string" || !isSqliteAtomString(maximumTransferAtoms)))
  ) return json({ error: "invalid_request", message: "Provide a valid business wallet, role, enabled flag and atom limits within the database accounting range." }, 400);
  if (role !== "reserve" && (minimumRemainingAtoms !== "0" || maximumTransferAtoms !== null)) {
    return json({ error: "reserve_limits_only_apply_to_reserve_wallets" }, 400);
  }

  const wallet = await env.DB.prepare(`
    SELECT id, purpose, ownership_verified_at FROM wallets
    WHERE id = ? AND business_id = ? AND scope = 'business'
      AND network = 'solana' AND status = 'active'
    LIMIT 1
  `).bind(walletId, businessId).first<{ id: string; purpose: string; ownership_verified_at: string | null }>();
  if (!wallet) return json({ error: "active_business_wallet_not_found" }, 404);

  if (role === "payment" && enabled) {
    const existingPayment = await env.DB.prepare(
      "SELECT wallet_id FROM wallet_role_assignments WHERE business_id = ? AND role = 'payment' AND enabled = 1 LIMIT 1"
    ).bind(businessId).first<{ wallet_id: string }>();
    if (existingPayment && existingPayment.wallet_id !== walletId) {
      return json({ error: "payment_wallet_already_assigned", message: "Disable the current payment-wallet assignment before selecting another." }, 409);
    }
  }

  if (enabled && !wallet.ownership_verified_at) {
    return json({ error: "wallet_ownership_not_verified", message: "Verify control of this wallet address before enabling a business role." }, 409);
  }

  // Keep the current x402 integration contract intact while legacy purpose is in use.
  if ((role === "api_payment") !== (wallet.purpose === "api_payment")) {
    return json({ error: "wallet_purpose_role_mismatch", message: "The API-payment role must match the existing api_payment wallet purpose. Other roles require an operating-purpose business wallet." }, 409);
  }
  try {
    await env.DB.prepare(`
      INSERT INTO wallet_role_assignments (
        business_id, wallet_id, role, enabled, priority,
        minimum_remaining_atoms, maximum_transfer_atoms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(wallet_id, role) DO UPDATE SET
        enabled = excluded.enabled, priority = excluded.priority,
        minimum_remaining_atoms = excluded.minimum_remaining_atoms,
        maximum_transfer_atoms = excluded.maximum_transfer_atoms,
        updated_at = datetime('now')
    `).bind(businessId, walletId, role, enabled ? 1 : 0, priority as number,
      minimumRemainingAtoms, maximumTransferAtoms).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("idx_wallet_roles_one_payment_per_business") || message.includes("UNIQUE constraint failed: wallet_role_assignments.business_id")) {
      return json({ error: "payment_wallet_already_assigned", message: "Disable the current payment-wallet assignment before selecting another." }, 409);
    }
    if (message.includes("api_payment_role_must_be_exclusive")) return json({ error: "api_payment_role_must_be_exclusive" }, 409);
    return json({ error: "wallet_role_assignment_failed" }, 409);
  }
  return json({ businessId, walletId, role, enabled, priority, minimumRemainingAtoms, maximumTransferAtoms });
}


function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_");
}

async function enforceWalletOwnershipRateLimit(env: Env, walletId: string, action: string, limit: number): Promise<Response | null> {
  const windowSeconds = 600;
  const windowKey = Math.floor(Date.now() / (windowSeconds * 1000));
  const bucketKey = "wallet-ownership:" + action + ":" + walletId;
  await env.DB.prepare("INSERT INTO api_rate_limits (bucket_key, window_key, request_count) VALUES (?, ?, 1) ON CONFLICT(bucket_key) DO UPDATE SET request_count = CASE WHEN api_rate_limits.window_key = excluded.window_key THEN api_rate_limits.request_count + 1 ELSE 1 END, window_key = excluded.window_key, updated_at = datetime('now')")
    .bind(bucketKey, windowKey).run();
  const row = await env.DB.prepare("SELECT request_count FROM api_rate_limits WHERE bucket_key = ? AND window_key = ?")
    .bind(bucketKey, windowKey).first<{ request_count: number }>();
  if (!row || row.request_count <= limit) return null;
  const retryAfter = Math.max(1, (windowKey + 1) * windowSeconds - Math.floor(Date.now() / 1000));
  return new Response(JSON.stringify({ error: "rate_limited", retryAfterSeconds: retryAfter }), {
    status: 429,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "retry-after": String(retryAfter) }
  });
}

async function createWalletOwnershipChallenge(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string" || typeof body.walletId !== "string" || body.businessId.length > 128 || body.walletId.length > 128) return json({ error: "invalid_request" }, 400);
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedAdminOrigin(origin, new URL(request.url).origin, env.ADMIN_ALLOWED_ORIGINS)) return json({ error: "origin_not_allowed" }, 403);
  const wallet = await env.DB.prepare("SELECT id, address, network FROM wallets WHERE id = ? AND business_id = ? AND scope = 'business' AND status = 'active' LIMIT 1")
    .bind(body.walletId, body.businessId).first<{ id: string; address: string; network: string }>();
  if (!wallet) return json({ error: "active_business_wallet_not_found" }, 404);
  if (wallet.network !== "solana") return json({ error: "unsupported_wallet_network" }, 400);
  const rateLimit = await enforceWalletOwnershipRateLimit(env, wallet.id, "challenge", 5);
  if (rateLimit) return rateLimit;

  await env.DB.prepare("UPDATE wallet_ownership_challenges SET consumed_at = datetime('now') WHERE wallet_id = ? AND consumed_at IS NULL").bind(wallet.id).run();

  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const nonceText = encodeBase64Url(nonce);
  const challengeId = crypto.randomUUID();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1000);
  const issuedText = issuedAt.toISOString();
  const expiresText = expiresAt.toISOString();
  const message = [
    "NERITH WALLET OWNERSHIP PROOF",
    "Origin: " + origin,
    "Business ID: " + body.businessId,
    "Wallet address: " + wallet.address,
    "Network: solana:mainnet-beta",
    "Nonce: " + nonceText,
    "Issued at: " + issuedText,
    "Expires at: " + expiresText,
    "",
    "This signature proves control of this wallet address only.",
    "It does not authorize spending or grant agent execution permission."
  ].join(String.fromCharCode(10));

  await env.DB.prepare("INSERT INTO wallet_ownership_challenges (id, business_id, wallet_id, address, origin, network, message, nonce_hash, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, 'solana:mainnet-beta', ?, ?, ?, ?)")
    .bind(challengeId, body.businessId, wallet.id, wallet.address, origin, message, await sha256(nonceText), issuedText, expiresText).run();
  return json({ challengeId, walletId: wallet.id, address: wallet.address, message, expiresAt: expiresText });
}

async function verifyWalletOwnership(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string" || typeof body.walletId !== "string" ||
      typeof body.challengeId !== "string" || typeof body.signature !== "string" ||
      body.businessId.length > 128 || body.walletId.length > 128 || body.challengeId.length > 64 || body.signature.length > 256) return json({ error: "invalid_request" }, 400);
  const origin = request.headers.get("origin");
  if (!origin || !isAllowedAdminOrigin(origin, new URL(request.url).origin, env.ADMIN_ALLOWED_ORIGINS)) return json({ error: "origin_not_allowed" }, 403);
  const rateLimit = await enforceWalletOwnershipRateLimit(env, body.walletId, "verify", 10);
  if (rateLimit) return rateLimit;

  const challenge = await env.DB.prepare("SELECT c.id, c.address, c.origin, c.network, c.message, c.nonce_hash, c.expires_at, w.address AS current_address FROM wallet_ownership_challenges c JOIN wallets w ON w.id = c.wallet_id AND w.business_id = c.business_id WHERE c.id = ? AND c.business_id = ? AND c.wallet_id = ? AND c.consumed_at IS NULL AND julianday(c.expires_at) > julianday('now') AND w.scope = 'business' AND w.status = 'active' AND w.network = 'solana' LIMIT 1")
    .bind(body.challengeId, body.businessId, body.walletId).first<{ id: string; address: string; origin: string; network: string; message: string; nonce_hash: string; expires_at: string; current_address: string }>();
  if (!challenge) return json({ error: "challenge_expired_or_consumed" }, 409);
  if (challenge.origin !== origin) return json({ error: "challenge_origin_mismatch" }, 403);
  if (challenge.network !== "solana:mainnet-beta" || challenge.address !== challenge.current_address) return json({ error: "challenge_wallet_mismatch" }, 409);
  const nonceLine = challenge.message.split(String.fromCharCode(10)).find(line => line.startsWith("Nonce: "));
  if (!nonceLine || await sha256(nonceLine.slice(7)) !== challenge.nonce_hash) return json({ error: "challenge_integrity_failure" }, 409);
  if (!(await verifySolanaMessageSignature(challenge.address, challenge.message, body.signature))) return json({ error: "invalid_wallet_signature" }, 400);

  const verifiedAt = new Date().toISOString();
  const signatureHash = await sha256(body.signature);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE wallet_ownership_challenges SET consumed_at = ?, verified_at = ?, signature_hash = ? WHERE id = ? AND business_id = ? AND wallet_id = ? AND consumed_at IS NULL AND julianday(expires_at) > julianday('now')")
      .bind(verifiedAt, verifiedAt, signatureHash, challenge.id, body.businessId, body.walletId),
    env.DB.prepare("UPDATE wallets SET ownership_verified_at = ?, ownership_verified_origin = ? WHERE id = ? AND business_id = ? AND address = ? AND scope = 'business' AND status = 'active' AND network = 'solana' AND EXISTS (SELECT 1 FROM wallet_ownership_challenges c WHERE c.id = ? AND c.verified_at = ? AND c.consumed_at = ?)")
      .bind(verifiedAt, origin, body.walletId, body.businessId, challenge.address, challenge.id, verifiedAt, verifiedAt)
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1) return json({ error: "challenge_already_used_or_expired" }, 409);
  return json({ verified: true, walletId: body.walletId, address: challenge.address, ownershipVerifiedAt: verifiedAt, ownershipVerifiedOrigin: origin, authority: "address_control_only" });
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
  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string") return json({ error: "business_id_required" }, 400);
  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
    .bind(body.businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  if (!env.SOLANA_RPC_URL) {
    return json({
      error: "solana_rpc_not_configured",
      message: "A production Solana RPC endpoint is not configured. Add SOLANA_RPC_URL as a Worker secret before syncing wallet balances."
    }, 503);
  }
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!/^https:\/\//i.test(rpcUrl)) {
    return json({ error: "solana_rpc_url_invalid", message: "SOLANA_RPC_URL must be an HTTPS mainnet RPC endpoint." }, 503);
  }
  const usdcMint = env.SOLANA_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const wallets = await env.DB.prepare(
    "SELECT id, address FROM wallets WHERE business_id = ? AND network = 'solana' AND status = 'active'"
  ).bind(body.businessId).all<{ id: string; address: string }>();

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
      const message = error instanceof Error ? error.message : "Balance sync failed";
      console.error("solana_balance_sync_wallet_failed", {
        walletId: wallet.id,
        error: message.slice(0, 240)
      });
      errors.push({
        walletId: wallet.id,
        error: message.slice(0, 240)
      });
    }
  }

  const allFailed = errors.length > 0 && synced.length === 0;
  return json({
    businessId: body.businessId,
    source: "solana_rpc",
    commitment: "confirmed",
    synced,
    errors,
    error: allFailed ? "solana_balance_sync_failed" : undefined,
    message: allFailed
      ? "No wallet balances could be synced. First RPC error: " + errors[0].error
      : errors.length
        ? synced.length + " wallet(s) synced; " + errors.length + " wallet(s) failed. First RPC error: " + errors[0].error
        : synced.length
          ? synced.length + " wallet(s) synced successfully."
          : "No active Solana wallets are registered for this business.",
    observedAt: new Date().toISOString()
  }, allFailed ? 502 : 200);
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


type X402ProxyContext = {
  env: Env;
  agent: AgentRow;
  paymentWalletAddress: string;
  requestHash: string;
};

type X402ChallengeRow = {
  id: string;
  amount_atoms: string;
  pay_to: string;
  asset: string;
  fee_payer: string;
  resource: string;
};

async function storeX402Challenge(
  context: X402ProxyContext,
  path: string,
  responseBody: string
): Promise<void> {
  const requirement = parseHermesPaymentRequirement(responseBody, path);
  if (!requirement || BigInt(requirement.maxAmountRequired) > 1_000_000_000n) return;
  const id = "x4c_" + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(Date.now() + requirement.maxTimeoutSeconds * 1000).toISOString();
  await context.env.DB.prepare(
    "UPDATE x402_payment_challenges SET status = 'expired' WHERE agent_id = ? AND request_hash = ? AND status = 'pending'"
  ).bind(context.agent.id, context.requestHash).run();
  await context.env.DB.prepare(`
    INSERT INTO x402_payment_challenges
      (id, agent_id, business_id, request_hash, resource, amount_atoms, pay_to, asset, fee_payer, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    context.agent.id,
    context.agent.business_id,
    context.requestHash,
    requirement.resource,
    requirement.maxAmountRequired,
    requirement.payTo,
    requirement.asset,
    requirement.feePayer,
    expiresAt
  ).run();
  await context.env.DB.prepare(
    "UPDATE x402_payment_challenges SET status = 'expired' WHERE agent_id = ? AND request_hash = ? AND status = 'pending' AND id <> ? AND julianday(expires_at) <= julianday('now')"
  ).bind(context.agent.id, context.requestHash, id).run();
}

async function reserveX402Payment(
  request: Request,
  context: X402ProxyContext
): Promise<{ reservationId: string; challenge: X402ChallengeRow } | Response | null> {
  const paymentHeader = request.headers.get("x-payment");
  if (!paymentHeader) {
    if (request.headers.get("payment-signature")) {
      return json({ error: "unsupported_x402_version", message: "Hermes currently requires its documented x402 V1 X-PAYMENT envelope." }, 400);
    }
    return null;
  }
  if (!parseHermesPaymentPayload(paymentHeader)) {
    return json({ error: "invalid_x402_payment_payload" }, 400);
  }
  const challenge = await context.env.DB.prepare(`
    SELECT id, amount_atoms, pay_to, asset, fee_payer, resource
    FROM x402_payment_challenges
    WHERE agent_id = ? AND request_hash = ? AND status = 'pending'
      AND julianday(expires_at) > julianday('now')
    ORDER BY created_at DESC LIMIT 1
  `).bind(context.agent.id, context.requestHash).first<X402ChallengeRow>();
  if (!challenge) {
    return json({ error: "x402_challenge_missing_or_expired", message: "Request a fresh Hermes payment challenge before retrying with payment." }, 409);
  }

  const paymentHash = await sha256(paymentHeader);
  const prior = await context.env.DB.prepare(
    "SELECT id, status FROM x402_payment_reservations WHERE payment_hash = ? OR challenge_id = ? LIMIT 1"
  ).bind(paymentHash, challenge.id).first<{ id: string; status: string }>();
  if (prior) {
    return json({ error: "x402_payment_replay_or_pending", status: prior.status }, 409);
  }

  const businessScope = "business:" + context.agent.business_id;
  const agentScope = "agent:" + context.agent.id;
  await context.env.DB.prepare(`
    INSERT OR IGNORE INTO x402_spend_limits (scope_key, business_id, agent_id, daily_limit_atoms)
    VALUES (?, ?, NULL, 50000), (?, ?, ?, 10000)
  `).bind(
    businessScope, context.agent.business_id,
    agentScope, context.agent.business_id, context.agent.id
  ).run();

  const amount = Number(challenge.amount_atoms);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return json({ error: "invalid_x402_challenge_amount" }, 502);
  }
  const day = new Date().toISOString().slice(0, 10);
  const reservationId = "x4r_" + crypto.randomUUID().replaceAll("-", "");
  let reserved;
  try {
    reserved = await context.env.DB.prepare(`
      INSERT INTO x402_payment_reservations
        (id, challenge_id, payment_hash, business_id, agent_id, payment_wallet_address, spend_day, amount_atoms, status)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
      WHERE EXISTS (
        SELECT 1 FROM x402_payment_challenges
        WHERE id = ? AND agent_id = ? AND status = 'pending' AND julianday(expires_at) > julianday('now')
      )
      AND COALESCE((
        SELECT SUM(amount_atoms) FROM x402_payment_reservations
        WHERE business_id = ? AND spend_day = ? AND status IN ('pending', 'settled')
      ), 0) + ? <= (
        SELECT daily_limit_atoms FROM x402_spend_limits WHERE scope_key = ?
      )
      AND COALESCE((
        SELECT SUM(amount_atoms) FROM x402_payment_reservations
        WHERE agent_id = ? AND spend_day = ? AND status IN ('pending', 'settled')
      ), 0) + ? <= (
        SELECT daily_limit_atoms FROM x402_spend_limits WHERE scope_key = ?
      )
    `).bind(
      reservationId, challenge.id, paymentHash, context.agent.business_id,
      context.agent.id, context.paymentWalletAddress, day, amount,
      challenge.id, context.agent.id,
      context.agent.business_id, day, amount, businessScope,
      context.agent.id, day, amount, agentScope
    ).run();
  } catch {
    return json({ error: "x402_payment_already_reserved" }, 409);
  }
  if ((reserved.meta?.changes ?? 0) !== 1) {
    return json({
      error: "x402_daily_budget_exceeded",
      amountUSDC: formatTokenAmount(BigInt(challenge.amount_atoms), 6),
      note: "The payment would exceed the configured daily limit for this agent or business. Default limits are 0.01 USDC per agent and 0.05 USDC per business."
    }, 429);
  }
  await context.env.DB.prepare(
    "UPDATE x402_payment_challenges SET status = 'reserved' WHERE id = ? AND status = 'pending'"
  ).bind(challenge.id).run();
  return { reservationId, challenge };
}

async function verifyX402Settlement(
  env: Env,
  receipt: { transaction: string; network: string; payer?: string },
  requirement: HermesPaymentRequirement,
  payerAddress: string
): Promise<{ verified: boolean; pending: boolean; reason: string }> {
  if (receipt.payer && receipt.payer !== payerAddress) {
    return { verified: false, pending: false, reason: "x402 receipt payer does not match the configured payment wallet." };
  }
  type PaymentTx = Parameters<typeof verifyHermesPaymentTransaction>[0];
  let transaction: PaymentTx | null;
  try {
    transaction = await solanaRpc<PaymentTx | null>(
      env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
      "getTransaction",
      [receipt.transaction, {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0
      }]
    );
  } catch {
    return { verified: false, pending: true, reason: "Solana RPC could not verify the x402 settlement yet." };
  }
  if (!transaction?.meta) {
    return { verified: false, pending: true, reason: "x402 settlement transaction is not yet available at finalized commitment." };
  }
  const result = verifyHermesPaymentTransaction(transaction, requirement, payerAddress);
  return { ...result, pending: false };
}

async function manageX402Budgets(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  if (request.method === "GET") {
    const businessId = new URL(request.url).searchParams.get("businessId");
    if (!businessId) return json({ error: "business_id_required" }, 400);
    const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(businessId).first<{ id: string }>();
    if (!business) return json({ error: "business_not_found" }, 404);
    await env.DB.prepare(`
      INSERT OR IGNORE INTO x402_spend_limits (scope_key, business_id, agent_id, daily_limit_atoms)
      VALUES (?, ?, NULL, 50000)
    `).bind("business:" + businessId, businessId).run();
    await env.DB.prepare(`
      INSERT OR IGNORE INTO x402_spend_limits (scope_key, business_id, agent_id, daily_limit_atoms)
      SELECT 'agent:' || id, business_id, id, 10000 FROM agents WHERE business_id = ?
    `).bind(businessId).run();
    const rows = await env.DB.prepare(`
      SELECT l.scope_key, l.agent_id, a.name AS agent_name, l.daily_limit_atoms,
        COALESCE((
          SELECT SUM(r.amount_atoms) FROM x402_payment_reservations r
          WHERE r.business_id = l.business_id AND r.spend_day = ? AND r.status IN ('pending', 'settled')
            AND ((l.agent_id IS NULL AND r.agent_id IS NOT NULL) OR r.agent_id = l.agent_id)
        ), 0) AS used_atoms
      FROM x402_spend_limits l
      LEFT JOIN agents a ON a.id = l.agent_id
      WHERE l.business_id = ?
      ORDER BY CASE WHEN l.agent_id IS NULL THEN 0 ELSE 1 END, a.name
    `).bind(new Date().toISOString().slice(0, 10), businessId).all<{
      scope_key: string; agent_id: string | null; agent_name: string | null; daily_limit_atoms: number; used_atoms: number;
    }>();
    const pendingPayments = await env.DB.prepare(`
      SELECT id, agent_id, payment_wallet_address, amount_atoms, receipt_tx, created_at
      FROM x402_payment_reservations
      WHERE business_id = ? AND status = 'pending'
      ORDER BY created_at DESC LIMIT 50
    `).bind(businessId).all<{
      id: string; agent_id: string; payment_wallet_address: string; amount_atoms: number;
      receipt_tx: string | null; created_at: string;
    }>();
    return json({
      businessId,
      defaults: { businessDailyUSDC: "0.05", agentDailyUSDC: "0.01" },
      budgets: (rows.results ?? []).map((row) => ({
        scope: row.agent_id ? "agent" : "business",
        agentId: row.agent_id,
        agentName: row.agent_name,
        dailyLimitUSDC: formatTokenAmount(BigInt(row.daily_limit_atoms), 6),
        usedTodayUSDC: formatTokenAmount(BigInt(row.used_atoms), 6)
      })),
      pendingPayments: (pendingPayments.results ?? []).map((row) => ({
        reservationId: row.id,
        agentId: row.agent_id,
        paymentWalletAddress: row.payment_wallet_address,
        amountUSDC: formatTokenAmount(BigInt(row.amount_atoms), 6),
        receiptTransaction: row.receipt_tx,
        createdAt: row.created_at,
        canReconcile: Boolean(row.receipt_tx)
      }))
    });
  }

  const body = await readJson(request);
  if (!body || typeof body.businessId !== "string" || typeof body.dailyLimitUSDC !== "string") {
    return json({ error: "invalid_request", message: "Provide businessId and dailyLimitUSDC; optionally provide agentId for an agent-specific cap." }, 400);
  }
  if (!/^\d{1,9}(?:\.\d{1,6})?$/.test(body.dailyLimitUSDC)) {
    return json({ error: "invalid_daily_limit", message: "dailyLimitUSDC must be a non-negative amount with up to six decimals." }, 400);
  }
  const [whole, fraction = ""] = body.dailyLimitUSDC.split(".");
  const limitAtoms = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  if (limitAtoms > 1_000_000_000_000n) return json({ error: "daily_limit_too_large" }, 400);
  const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?").bind(body.businessId).first<{ id: string }>();
  if (!business) return json({ error: "business_not_found" }, 404);
  let scopeKey = "business:" + body.businessId;
  let agentId: string | null = null;
  if (body.agentId !== undefined) {
    if (typeof body.agentId !== "string") return json({ error: "invalid_agent_id" }, 400);
    const agent = await env.DB.prepare("SELECT id FROM agents WHERE id = ? AND business_id = ?")
      .bind(body.agentId, body.businessId).first<{ id: string }>();
    if (!agent) return json({ error: "agent_not_found" }, 404);
    agentId = agent.id;
    scopeKey = "agent:" + agent.id;
  }
  await env.DB.prepare(`
    INSERT INTO x402_spend_limits (scope_key, business_id, agent_id, daily_limit_atoms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_key) DO UPDATE SET daily_limit_atoms = excluded.daily_limit_atoms, updated_at = datetime('now')
  `).bind(scopeKey, body.businessId, agentId, limitAtoms.toString()).run();
  return json({
    scope: agentId ? "agent" : "business",
    businessId: body.businessId,
    agentId,
    dailyLimitUSDC: formatTokenAmount(limitAtoms, 6)
  });
}

async function reconcileX402PaymentAdmin(request: Request, env: Env): Promise<Response> {
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.reservationId !== "string") {
    return json({ error: "invalid_request", message: "Provide reservationId." }, 400);
  }
  const row = await env.DB.prepare(`
    SELECT r.id, r.status, r.receipt_tx, r.payment_wallet_address, r.amount_atoms,
      c.id AS challenge_id, c.resource, c.pay_to, c.asset, c.fee_payer
    FROM x402_payment_reservations r
    JOIN x402_payment_challenges c ON c.id = r.challenge_id
    WHERE r.id = ?
  `).bind(body.reservationId).first<{
    id: string; status: string; receipt_tx: string | null; payment_wallet_address: string;
    amount_atoms: string; challenge_id: string; resource: string; pay_to: string; asset: string; fee_payer: string;
  }>();
  if (!row) return json({ error: "x402_reservation_not_found" }, 404);
  if (row.status === "settled") return json({ reservationId: row.id, status: "settled", transaction: row.receipt_tx });
  if (row.status !== "pending" || !row.receipt_tx) {
    return json({ error: "x402_reservation_not_reconcilable", status: row.status, message: "A finalized receipt transaction is required before reconciliation." }, 409);
  }
  const requirement: HermesPaymentRequirement = {
    scheme: "exact", network: "solana", maxAmountRequired: row.amount_atoms,
    resource: row.resource, payTo: row.pay_to, asset: row.asset, feePayer: row.fee_payer, maxTimeoutSeconds: 60
  };
  const verification = await verifyX402Settlement(
    env,
    { transaction: row.receipt_tx, network: "solana" },
    requirement,
    row.payment_wallet_address
  );
  if (verification.pending) return json({ reservationId: row.id, status: "pending", message: verification.reason }, 202);
  if (!verification.verified) return json({ reservationId: row.id, status: "pending", error: "x402_settlement_mismatch", message: verification.reason }, 409);
  await env.DB.prepare(
    "UPDATE x402_payment_reservations SET status = 'settled', settled_at = datetime('now') WHERE id = ? AND status = 'pending'"
  ).bind(row.id).run();
  await env.DB.prepare(
    "UPDATE x402_payment_challenges SET status = 'settled' WHERE id = ? AND status = 'reserved'"
  ).bind(row.challenge_id).run();
  return json({ reservationId: row.id, status: "settled", transaction: row.receipt_tx });
}

async function proxyHermes(
  request: Request,
  path: string,
  payload: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
  x402Context?: X402ProxyContext
): Promise<Response> {
  const payment = request.headers.get("x-payment");
  const paymentSignature = request.headers.get("payment-signature");
  if (paymentSignature) {
    return json({ error: "unsupported_x402_version", message: "Hermes requires its documented V1 X-PAYMENT envelope." }, 400);
  }
  if (payment && !x402Context) return json({ error: "x402_budget_context_missing" }, 500);

  let paymentReservation: { reservationId: string; challenge: X402ChallengeRow } | null = null;
  if (payment && x402Context) {
    const reserved = await reserveX402Payment(request, x402Context);
    if (reserved instanceof Response) return reserved;
    paymentReservation = reserved;
    if (!paymentReservation) return json({ error: "x402_payment_not_reserved" }, 500);
  }

  const headers = new Headers({ "content-type": "application/json" });
  if (payment) headers.set("X-PAYMENT", payment);
  if (paymentSignature) headers.set("PAYMENT-SIGNATURE", paymentSignature);

  let upstream: Response;
  try {
    const localTestRequest = new URL(request.url).hostname === "127.0.0.1";
    const testFixture = localTestRequest && x402Context?.env.NERITH_TEST_MODE === "true"
      ? x402Context.env.HERMES_TEST_402_FIXTURE
      : undefined;
    if (testFixture) {
      // CI-only replay of a real, previously captured unpaid Hermes 402 response.
      // Validate the exact request built by the quote handler before replaying the fixture.
      // Production must leave NERITH_TEST_MODE unset and always use the live Hermes host.
      const input = payload.input as { token?: unknown; amount?: unknown; chainKey?: unknown } | undefined;
      const output = payload.output as { token?: unknown; chainKey?: unknown } | undefined;
      const expectedUserAddress = "BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD";
      const validOutgoingQuote =
        path === "/v1/swap/quote" &&
        input?.token === SOL_MINT &&
        input?.amount === "1000000000" &&
        input?.chainKey === "sol" &&
        output?.token === USDC_MINT &&
        output?.chainKey === "sol" &&
        payload.userAddress === expectedUserAddress &&
        payload.slippageBps === 50;
      if (!validOutgoingQuote) {
        throw new Error("Local Hermes fixture rejected an unexpected outgoing quote payload.");
      }
      console.log("nerith_test_hermes_request_validated", JSON.stringify({
        path,
        inputToken: input.token,
        inputAmount: input.amount,
        inputChain: input.chainKey,
        outputToken: output.token,
        outputChain: output.chainKey,
        userAddress: payload.userAddress,
        slippageBps: payload.slippageBps
      }));
      const fixture = JSON.parse(atob(testFixture)) as {
        status?: number;
        body?: string;
        headers?: Record<string, string>;
      };
      if (fixture.status !== 402 || typeof fixture.body !== "string") {
        throw new Error("Invalid local Hermes 402 test fixture.");
      }
      upstream = new Response(fixture.body, {
        status: 402,
        headers: fixture.headers ?? { "content-type": "application/json" }
      });
    } else {
      upstream = await fetch(new URL(path, "https://hermes.swap.io"), {
        method: "POST", headers, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(12_000), redirect: "error"
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown upstream fetch error";
    console.error("hermes_upstream_fetch_failed", { path, error: message.slice(0, 240) });
    // A timeout after forwarding a payment is ambiguous. Keep its budget reservation
    // pending rather than incorrectly making the same daily allowance available again.
    return json({ error: "swap_provider_unavailable", message: "Hermes did not respond within the allowed time." }, 504);
  }

  const maxBytes = path === "/v1/swap/quote" ? 1_000_000 : 512_000;
  const declaredSize = Number(upstream.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await upstream.body?.cancel();
    return json({ error: "swap_provider_response_too_large" }, 502);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = upstream.body?.getReader();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return json({ error: "swap_provider_response_too_large" }, 502);
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      return json({ error: "swap_provider_response_incomplete" }, 502);
    }
  }
  const responseBody = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { responseBody.set(chunk, offset); offset += chunk.byteLength; }
  const responseText = new TextDecoder().decode(responseBody);

  const responseHeaders = new Headers({
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  for (const name of ["x-payment-required", "payment-required", "x-payment-response", "payment-response"]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const [name, value] of Object.entries(extraHeaders)) responseHeaders.set(name, value);

  if (upstream.status === 402 && x402Context) {
    await storeX402Challenge(x402Context, path, responseText);
  }

  if (paymentReservation && x402Context) {
    const receiptHeader = upstream.headers.get("x-payment-response") ?? upstream.headers.get("payment-response");
    if (receiptHeader) {
      const receipt = parseHermesPaymentReceipt(receiptHeader);
      if (!receipt) {
        return json({ error: "x402_receipt_invalid", message: "Hermes returned a receipt that could not be safely reconciled. The budget remains reserved pending review." }, 502);
      }
      await x402Context.env.DB.prepare(
        "UPDATE x402_payment_reservations SET receipt_tx = ? WHERE id = ? AND status = 'pending' AND (receipt_tx IS NULL OR receipt_tx = ?)"
      ).bind(receipt.transaction, paymentReservation.reservationId, receipt.transaction).run();
      const requirement: HermesPaymentRequirement = {
        scheme: "exact",
        network: "solana",
        maxAmountRequired: paymentReservation.challenge.amount_atoms,
        resource: paymentReservation.challenge.resource,
        payTo: paymentReservation.challenge.pay_to,
        asset: paymentReservation.challenge.asset,
        feePayer: paymentReservation.challenge.fee_payer,
        maxTimeoutSeconds: 60
      };
      const verification = await verifyX402Settlement(
        x402Context.env,
        receipt,
        requirement,
        x402Context.paymentWalletAddress
      );
      if (verification.pending) {
        return json({ error: "x402_settlement_pending", message: verification.reason, paymentReservationId: paymentReservation.reservationId }, 202);
      }
      if (!verification.verified) {
        return json({ error: "x402_settlement_mismatch", message: verification.reason, paymentReservationId: paymentReservation.reservationId }, 502);
      }
      await x402Context.env.DB.prepare(
        "UPDATE x402_payment_reservations SET status = 'settled', settled_at = datetime('now') WHERE id = ? AND status = 'pending'"
      ).bind(paymentReservation.reservationId).run();
      await x402Context.env.DB.prepare(
        "UPDATE x402_payment_challenges SET status = 'settled' WHERE id = ? AND status = 'reserved'"
      ).bind(paymentReservation.challenge.id).run();
    } else if (upstream.status === 200 || upstream.status === 504) {
      // Missing receipt on a nominal success, or an ambiguous timeout: retain the hold.
      if (upstream.status === 200) {
        return json({ error: "swap_payment_receipt_missing_or_invalid", message: "Hermes returned HTTP 200 without a successful x402 settlement receipt. The payment remains reserved until reconciled." }, 502);
      }
    } else {
      // Hermes documents failed upstream calls as uncharged; absent a receipt, release
      // the hold and require a fresh challenge before another payment attempt.
      await x402Context.env.DB.prepare(
        "UPDATE x402_payment_reservations SET status = 'released' WHERE id = ? AND status = 'pending' AND receipt_tx IS NULL"
      ).bind(paymentReservation.reservationId).run();
      await x402Context.env.DB.prepare(
        "UPDATE x402_payment_challenges SET status = 'expired' WHERE id = ? AND status = 'reserved'"
      ).bind(paymentReservation.challenge.id).run();
    }
  } else if (upstream.status === 200 && (path === "/v1/swap/quote" || path === "/v1/swap/build-tx")) {
    return json({ error: "swap_payment_receipt_missing_or_untracked", message: "A successful paid Hermes response must have a tracked, reconciled x402 payment." }, 502);
  }

  return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
}

async function requestSwapQuote(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const limited = await enforceAgentRateLimit(env, agent.id, "swap_quote", 4, 600);
  if (limited) return limited;
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const context = await validateConversionContext(agent, body, env);
  if (context instanceof Response) return context;

  const slippageBps = body.slippageBps === undefined ? 50 : body.slippageBps;
  if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 300) {
    return json({ error: "invalid_slippage", message: "slippageBps must be an integer from 1 to 300." }, 400);
  }

  const hermesPayload = {
    input: { token: SOL_MINT, amount: context.sourceAtoms.toString(), chainKey: "sol" },
    output: { token: USDC_MINT, chainKey: "sol" },
    userAddress: context.userAddress,
    slippageBps
  };
  const x402Context: X402ProxyContext = {
    env, agent, paymentWalletAddress: context.paymentWalletAddress,
    requestHash: await sha256(context.operationId + "\n" + context.paymentWalletAddress + "\n/v1/swap/quote\n" + JSON.stringify(hermesPayload))
  };
  const upstream = await proxyHermes(request, "/v1/swap/quote", hermesPayload, {
    "X-Liquidity-Operation-ID": context.operationId,
    "X-Liquidity-Required-USDC": formatTokenAmount(context.shortfallAtoms, 6)
  }, x402Context);

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
  const limited = await enforceAgentRateLimit(env, agent.id, "swap_prepare", 3, 600);
  if (limited) return limited;
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
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)
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
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)"
      ).bind(context.sourceAtoms.toString(), context.walletBalanceId, context.sourceAtoms.toString()).run();
      await env.DB.prepare("DELETE FROM reservations WHERE id = ? AND status = 'active'").bind(reservationId).run();
      return json({ error: "source_reservation_failed" }, 409);
    }
  }

  const hermesPayload = {
    provider,
    userAddress: context.userAddress,
    chainKey: "sol",
    quoteResponse: providerQuote
  };
  const x402Context: X402ProxyContext = {
    env, agent, paymentWalletAddress: context.paymentWalletAddress,
    requestHash: await sha256(context.operationId + "\n" + context.paymentWalletAddress + "\n/v1/swap/build-tx\n" + JSON.stringify(hermesPayload))
  };
  const upstream = await proxyHermes(request, "/v1/swap/build-tx", hermesPayload, {
    "X-Liquidity-Operation-ID": context.operationId,
    "X-Liquidity-Required-USDC": formatTokenAmount(context.shortfallAtoms, 6),
    "X-Liquidity-Source-Reserved-SOL": context.sourceAmount
  }, x402Context);

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

async function createLiquidityRequest(request: Request, env: Env, trustedAgent?: AgentRow, telegramOrigin?: { chatId: string; userId: string }): Promise<Response> {
  const agent = trustedAgent ?? await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const limited = await enforceAgentRateLimit(env, agent.id, "liquidity_create", 20, 60);
  if (limited) return limited;
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
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)
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
        `).bind(reservationId, operationId, candidate.row.balance_id, requestedAtoms.toString(), expiresAt),
        ...(telegramOrigin ? [
          env.DB.prepare("INSERT INTO telegram_request_origins (business_id, operation_id, telegram_chat_id, telegram_user_id) VALUES (?, ?, ?, ?)")
            .bind(agent.business_id, operationId, telegramOrigin.chatId, telegramOrigin.userId)
        ] : [])
      ]);
    } catch {
      await env.DB.prepare(
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)"
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
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)
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
      ] : []),
      ...(telegramOrigin ? [
        env.DB.prepare("INSERT INTO telegram_request_origins (business_id, operation_id, telegram_chat_id, telegram_user_id) VALUES (?, ?, ?, ?)")
          .bind(agent.business_id, operationId, telegramOrigin.chatId, telegramOrigin.userId)
      ] : [])
    ]);
  } catch {
    if (targetReservationId && targetBalanceId && targetReservedAtoms > 0n) {
      await env.DB.prepare(
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)"
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
    "SELECT id, wallet_balance_id, amount_atoms, token, reservation_source FROM reservations WHERE operation_id = ? AND status = 'active'"
  ).bind(operationId).all<{
    id: string;
    wallet_balance_id: string;
    amount_atoms: string;
    token: string;
    reservation_source: string;
  }>();

  const processed: Array<{ id: string; wallet_balance_id: string; amount_atoms: string; token: string; debited: boolean }> = [];
  for (const reservation of reservations.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).bind(reservation.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    if ((reservation.reservation_source !== "managed" && reservation.reservation_source !== "managed_fee")) {
      const debit = await env.DB.prepare(`
        UPDATE wallet_balances
        SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?
        WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)
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
    }

    processed.push({ ...reservation, debited: true });
  }

  await env.DB.prepare("UPDATE business_payment_intents SET status = 'cancelled' WHERE operation_id = ? AND status IN ('reserved', 'replenishing', 'awaiting_owner_approval', 'awaiting_signature')").bind(operationId).run();

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
  const paymentIntent = await env.DB.prepare("SELECT id, status FROM business_payment_intents WHERE operation_id = ? LIMIT 1")
    .bind(operationId).first<{ id: string; status: string }>();
  if (paymentIntent) return json({ error: "payment_confirmation_required", paymentIntentId: paymentIntent.id, paymentStatus: paymentIntent.status }, 409);

  if (operation.status !== "reserved" && operation.status !== "conversion_settled") {
    return json({ error: "operation_not_completable", status: operation.status }, 409);
  }

  const claimOperation = await env.DB.prepare(
    "UPDATE operations SET status = 'completed' WHERE id = ? AND agent_id = ? AND status = ?"
  ).bind(operationId, agent.id, operation.status).run();
  if ((claimOperation.meta?.changes ?? 0) !== 1) return json({ error: "operation_state_changed" }, 409);

  const reservations = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms, token, reservation_source FROM reservations WHERE operation_id = ? AND status = 'active'"
  ).bind(operationId).all<{
    id: string;
    wallet_balance_id: string;
    amount_atoms: string;
    token: string;
    reservation_source: string;
  }>();

  const processed: Array<{ id: string; wallet_balance_id: string; amount_atoms: string }> = [];
  for (const reservation of reservations.results ?? []) {
    const claim = await env.DB.prepare(
      "UPDATE reservations SET status = 'consumed', released_at = datetime('now') WHERE id = ? AND status = 'active'"
    ).bind(reservation.id).run();
    if ((claim.meta?.changes ?? 0) !== 1) continue;

    if ((reservation.reservation_source !== "managed" && reservation.reservation_source !== "managed_fee")) {
      const debit = await env.DB.prepare(`
        UPDATE wallet_balances
        SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ?, observed_at = datetime('now', '-10 minutes')
        WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)
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
  // Recover terminal operations whose Worker invocation stopped before all reservation
  // rows were processed. The reservation table is the source of truth for aggregate holds.
  // Run the repair statements in one D1 batch so a retry cannot double-debit a wallet.
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE reservations
      SET status = CASE
        WHEN (SELECT status FROM operations WHERE id = reservations.operation_id) = 'completed' THEN 'consumed'
        WHEN (SELECT status FROM operations WHERE id = reservations.operation_id) IN ('released', 'conversion_failed') THEN 'released'
        WHEN (SELECT status FROM operations WHERE id = reservations.operation_id) = 'expired' THEN 'expired'
        ELSE status
      END,
      released_at = COALESCE(released_at, datetime('now'))
      WHERE status = 'active'
        AND operation_id IN (
          SELECT id FROM operations WHERE status IN ('completed', 'released', 'expired', 'conversion_failed')
        )
    `),
    env.DB.prepare(`
      UPDATE wallet_balances
      SET reserved_atoms = CAST((
        SELECT COALESCE(SUM(CAST(r.amount_atoms AS INTEGER)), 0)
        FROM reservations r
        WHERE r.wallet_balance_id = wallet_balances.id AND r.status = 'active'
      ) AS TEXT)
      WHERE CAST(reserved_atoms AS INTEGER) != (
        SELECT COALESCE(SUM(CAST(r.amount_atoms AS INTEGER)), 0)
        FROM reservations r
        WHERE r.wallet_balance_id = wallet_balances.id AND r.status = 'active'
      )
    `),
    env.DB.prepare(`
      UPDATE wallet_balances
      SET observed_at = datetime('now', '-10 minutes')
      WHERE id IN (
        SELECT r.wallet_balance_id
        FROM reservations r
        JOIN operations o ON o.id = r.operation_id
        WHERE o.status = 'completed' AND r.status = 'consumed'
      )
    `)
  ]);

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
      AND NOT EXISTS (
        SELECT 1 FROM business_payment_intents payment_intent
        WHERE payment_intent.operation_id = o.id AND payment_intent.status = 'ambiguous'
      )
      AND NOT EXISTS (
        SELECT 1 FROM operation_funding_legs pending_leg
        WHERE pending_leg.operation_id = o.id AND pending_leg.status IN ('submitted', 'ambiguous')
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
      "SELECT id, wallet_balance_id, amount_atoms, reservation_source FROM reservations WHERE operation_id = ? AND status = 'active'"
    ).bind(operation.id).all<{
      id: string;
      wallet_balance_id: string;
      amount_atoms: string;
      reservation_source: string;
    }>();

    const processed: Array<{ id: string; wallet_balance_id: string; amount_atoms: string; debited: boolean }> = [];
    let failed = false;
    for (const reservation of reservations.results ?? []) {
      const claim = await env.DB.prepare(
        "UPDATE reservations SET status = 'expired', released_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).bind(reservation.id).run();
      if ((claim.meta?.changes ?? 0) !== 1) continue;

      if (reservation.reservation_source !== "managed" && reservation.reservation_source !== "managed_fee") {
        const debit = await env.DB.prepare(
          "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)"
        ).bind(reservation.amount_atoms, reservation.wallet_balance_id, reservation.amount_atoms).run();
        if ((debit.meta?.changes ?? 0) !== 1) {
          await env.DB.prepare(
            "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'expired'"
          ).bind(reservation.id).run();
          failed = true;
          break;
        }
      }
      // Managed rows were decremented by their D1 trigger; legacy rows above.
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
    await env.DB.prepare("UPDATE business_payment_intents SET status = 'expired' WHERE operation_id = ? AND status IN ('reserved', 'replenishing', 'awaiting_owner_approval', 'awaiting_signature')").bind(operation.id).run();

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
  const limited = await enforceAgentRateLimit(env, agent.id, "swap_track", 20, 60);
  if (limited) return limited;
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
    `Swap transaction submitted for operation ${operationId}.\nTransaction hash: ${transactionHash}\nSolscan: https://solscan.io/tx/${encodeURIComponent(transactionHash)}\nAwaiting final confirmation.`
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

  const limited = await enforceAgentRateLimit(env, agent.id, "swap_status", 30, 60);
  if (limited) return limited;
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
      const sourceDebitVerification = verifySolSourceDebit(
        transaction as SolanaSettlementTransaction,
        wallet.address,
        BigInt(reservation.amount_atoms)
      );

      const sumOwnerUsdc = (entries: ParsedTokenBalance[] | undefined) =>
        (entries ?? []).filter((entry) => entry.owner === wallet.address && entry.mint === USDC_MINT)
          .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount?.amount ?? "0"), 0n);

      const beforeUsdc = sumOwnerUsdc(transaction.meta.preTokenBalances);
      const afterUsdc = sumOwnerUsdc(transaction.meta.postTokenBalances);
      outputAtoms = afterUsdc > beforeUsdc ? afterUsdc - beforeUsdc : 0n;

      if (!sourceWalletSigned || !sourceDebitVerification.verified || outputAtoms === 0n) {
        effectiveStatus = "unverified";
        settlementNote = !sourceWalletSigned
          ? "The finalized transaction did not show the registered operating wallet as a signer."
          : !sourceDebitVerification.verified
            ? sourceDebitVerification.reason
            : "The finalized transaction did not show USDC received by the registered operating wallet.";
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
      "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)"
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
      "SELECT id, wallet_balance_id, amount_atoms, status, reservation_source FROM reservations WHERE id = ?"
    ).bind(operation.target_reservation_id).first<{
      id: string;
      wallet_balance_id: string;
      amount_atoms: string;
      status: string;
      reservation_source: string;
    }>();

    if (targetReservation?.status === "active" && effectiveStatus === "failed") {
      const claimTarget = await env.DB.prepare(
        "UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'active'"
      ).bind(targetReservation.id).run();
      if ((claimTarget.meta?.changes ?? 0) === 1) {
        if ((targetReservation.reservation_source !== "managed" && targetReservation.reservation_source !== "managed_fee")) {
          const debitTarget = await env.DB.prepare(
            "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= CAST(? AS INTEGER)"
          ).bind(targetReservation.amount_atoms, targetReservation.wallet_balance_id, targetReservation.amount_atoms).run();
          if ((debitTarget.meta?.changes ?? 0) !== 1) {
          await env.DB.prepare(
            "UPDATE reservations SET status = 'active', released_at = NULL WHERE id = ? AND status = 'released'"
          ).bind(targetReservation.id).run();
          return json({ error: "target_reservation_ledger_mismatch" }, 409);
          }
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
      `Conversion update for ${operationId}: ${nextStatus}.\nTransaction hash: ${operation.transaction_hash}\nSolscan: https://solscan.io/tx/${encodeURIComponent(operation.transaction_hash ?? "")}\n${outputAtoms > 0n ? formatTokenAmount(outputAtoms, 6) + " USDC received." : settlementNote ?? "No verified USDC receipt."}`
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

type BusinessForecastItem = {
  agentId: string;
  agentName: string;
  taskId: string;
  dueAt: string;
  purpose: string;
  amountUSDC: string;
  availableUSDC: string;
  shortfallUSDC: string;
  status: "covered" | "conversion_required" | "blocked";
  sourceWalletId: string | null;
  sourceAsset: string | null;
  sourceSOLAvailable?: string;
  quoteRequired?: boolean;
};

async function calculateBusinessLiquidityForecast(businessId: string, env: Env): Promise<{
  wallets: ForecastWallet[];
  obligations: BusinessForecastItem[];
  summary: { planned: number; covered: number; conversionRequired: number; blocked: number; totalShortfallUSDC: string };
  businessBalanceDataFresh: boolean;
  truncated: boolean;
}> {
  const balanceRows = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.address, w.scope, w.agent_id, b.token,
           b.confirmed_atoms, b.reserved_atoms, b.observed_at
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id
    WHERE w.business_id = ? AND w.status = 'active' AND w.purpose = 'operating'
      AND w.network = 'solana'
  `).bind(businessId).all<{
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
    SELECT o.agent_id, a.name AS agent_name, o.task_id, o.amount_atoms, o.due_at, o.purpose,
           a.can_use_business_treasury
    FROM liquidity_obligations o
    JOIN agents a ON a.id = o.agent_id AND a.business_id = o.business_id
    WHERE o.business_id = ? AND o.status = 'planned'
      AND a.status = 'active'
      AND julianday(o.due_at) > julianday('now')
      AND julianday(o.due_at) <= julianday('now', '+30 days')
    ORDER BY o.due_at ASC
    LIMIT 200
  `).bind(businessId).all<{
    agent_id: string;
    agent_name: string;
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
  ).bind(businessId).all<{ source_wallet_id: string | null }>();
  for (const pending of pendingConversions.results ?? []) {
    if (pending.source_wallet_id) conversionUsedWallets.add(pending.source_wallet_id);
  }

  const allForecast: BusinessForecastItem[] = (obligations.results ?? []).map((obligation) => {
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
        agentName: obligation.agent_name,
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
        agentName: obligation.agent_name,
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
      agentName: obligation.agent_name,
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

  const summary = allForecast.reduce((acc, item) => {
    if (item.status === "covered") acc.covered++;
    else if (item.status === "conversion_required") acc.conversionRequired++;
    else acc.blocked++;
    if (item.shortfallUSDC !== "0") acc.totalShortfallAtoms += parseTokenAmount(item.shortfallUSDC);
    return acc;
  }, { covered: 0, conversionRequired: 0, blocked: 0, totalShortfallAtoms: 0n });

  return {
    wallets: [...wallets.values()],
    obligations: allForecast,
    summary: {
      planned: summary.covered + summary.conversionRequired + summary.blocked,
      covered: summary.covered,
      conversionRequired: summary.conversionRequired,
      blocked: summary.blocked,
      totalShortfallUSDC: formatTokenAmount(summary.totalShortfallAtoms, 6)
    },
    businessBalanceDataFresh: wallets.size > 0 &&
      [...wallets.values()].every((wallet) => wallet.usdcFresh && wallet.solFresh),
    truncated: (obligations.results ?? []).length === 200
  };
}

async function buildLiquidityForecast(agent: AgentRow, env: Env): Promise<Record<string, unknown>> {
  const business = await calculateBusinessLiquidityForecast(agent.business_id, env);
  const ownForecast = business.obligations.filter((item) => item.agentId === agent.id);
  const ownSummary = ownForecast.reduce((acc, item) => {
    if (item.status === "covered") acc.covered++;
    else if (item.status === "conversion_required") acc.conversionRequired++;
    else acc.blocked++;
    if (item.shortfallUSDC !== "0") acc.totalShortfallAtoms += parseTokenAmount(item.shortfallUSDC);
    return acc;
  }, { covered: 0, conversionRequired: 0, blocked: 0, totalShortfallAtoms: 0n });
  const relevantWallets = business.wallets.filter((wallet) =>
    (wallet.scope === "agent" && wallet.agentId === agent.id) ||
    (wallet.scope === "business" && agent.can_use_business_treasury === 1)
  );
  const balanceDataFresh = relevantWallets.length > 0 &&
    relevantWallets.every((wallet) => wallet.usdcFresh && wallet.solFresh);
  const toSummary = (summary: typeof ownSummary) => ({
    planned: summary.covered + summary.conversionRequired + summary.blocked,
    covered: summary.covered,
    conversionRequired: summary.conversionRequired,
    blocked: summary.blocked,
    totalShortfallUSDC: formatTokenAmount(summary.totalShortfallAtoms, 6)
  });

  return {
    windowDays: 30,
    balanceDataFresh,
    businessBalanceDataFresh: business.businessBalanceDataFresh,
    walletsObserved: relevantWallets.length,
    obligations: ownForecast.map(({ agentId: _agentId, agentName: _agentName, ...item }) => item),
    summary: toSummary(ownSummary),
    businessSummary: {
      ...business.summary,
      otherAgentObligations: business.obligations.filter((item) => item.agentId !== agent.id).length
    },
    note: "Business-wide forecast allocates shared business wallets across all agents in due-date order. Private wallets remain agent-isolated. Conversion availability is indicative until a live Swap.io quote is obtained; no future funds are reserved."
  };
}

async function getAdminBusinessForecast(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
    const businessId = new URL(request.url).searchParams.get("businessId");
    if (!businessId) return json({ error: "business_id_required" }, 400);
    const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
      .bind(businessId).first<{ id: string }>();
    if (!business) return json({ error: "business_not_found" }, 404);

    const forecast = await calculateBusinessLiquidityForecast(businessId, env);
    return json({
      windowDays: 30,
      generatedAt: new Date().toISOString(),
      businessBalanceDataFresh: forecast.businessBalanceDataFresh,
      walletsObserved: forecast.wallets.length,
      wallets: forecast.wallets.map((wallet) => ({
        walletId: wallet.walletId,
        address: wallet.address,
        scope: wallet.scope,
        agentId: wallet.agentId,
        usdcFresh: wallet.usdcFresh,
        solFresh: wallet.solFresh
      })),
      obligations: forecast.obligations,
      summary: forecast.summary,
      truncated: forecast.truncated,
      confidence: "not_available",
      note: "Forecasts are indicative, not reservations. Stale balance snapshots are treated as zero available and can overstate shortfalls. Conversion-required items identify a possible SOL source only; no live quote, fees, slippage, price impact or route availability has been checked."
    });
  } catch {
    return json({ error: "internal_error" }, 500);
  }
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
  await notifyBusiness(
    env,
    agent.business_id,
    `Planned obligation ${taskId} marked ${status} by agent ${agent.id}.`
  );
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

const ADMIN_OPERATION_STATUSES = new Set([
  "reserved",
  "awaiting_conversion",
  "preparing_conversion",
  "conversion_submitted",
  "verification_pending",
  "conversion_settled",
  "conversion_settled_shortfall",
  "conversion_unverified",
  "conversion_failed",
  "ready_for_fulfillment",
  "blocked",
  "completed",
  "released",
  "expired"
]);

type AdminOperationRow = {
  id: string;
  agent_id: string;
  agent_name: string;
  task_id: string;
  network: string;
  token: string;
  amount_atoms: string;
  purpose: string;
  status: string;
  action: string;
  available_atoms: string;
  shortfall_atoms: string;
  source_wallet_id: string | null;
  transaction_hash: string | null;
  received_output_atoms: string | null;
  settlement_note: string | null;
  created_at: string;
  approval_decision: string | null;
  approval_decided_at: string | null;
  approval_telegram_user_id: string | null;
  has_active_reservation: number;
};

async function getAdminBusinessOperations(request: Request, env: Env): Promise<Response> {
  try {
    if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
    const url = new URL(request.url);
    const businessId = url.searchParams.get("businessId");
    if (!businessId) return json({ error: "business_id_required" }, 400);
    const business = await env.DB.prepare("SELECT id FROM businesses WHERE id = ?")
      .bind(businessId).first<{ id: string }>();
    if (!business) return json({ error: "business_not_found" }, 404);

    const rawLimit = url.searchParams.get("limit");
    let limit = 50;
    if (rawLimit !== null) {
      if (!/^\d+$/.test(rawLimit)) return json({ error: "invalid_limit" }, 400);
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return json({ error: "invalid_limit" }, 400);
    }

    const status = url.searchParams.get("status");
    if (status !== null && !ADMIN_OPERATION_STATUSES.has(status)) {
      return json({ error: "invalid_status" }, 400);
    }

    let cursor: { createdAt: string; id: string } | null = null;
    const rawCursor = url.searchParams.get("cursor");
    if (rawCursor !== null) {
      try {
        const parsed: unknown = JSON.parse(atob(rawCursor));
        if (!parsed || typeof parsed !== "object" ||
            typeof (parsed as Record<string, unknown>).createdAt !== "string" ||
            typeof (parsed as Record<string, unknown>).id !== "string" ||
            !(parsed as Record<string, unknown>).createdAt ||
            !(parsed as Record<string, unknown>).id) {
          return json({ error: "invalid_cursor" }, 400);
        }
        cursor = {
          createdAt: (parsed as { createdAt: string }).createdAt,
          id: (parsed as { id: string }).id
        };
        if (!Number.isFinite(Date.parse(cursor.createdAt)) || cursor.id.length > 200) {
          return json({ error: "invalid_cursor" }, 400);
        }
      } catch {
        return json({ error: "invalid_cursor" }, 400);
      }
    }

    const countRows = await env.DB.prepare(
      "SELECT status, COUNT(*) AS count FROM operations WHERE business_id = ? GROUP BY status"
    ).bind(businessId).all<{ status: string; count: number }>();
    const statusCounts: Record<string, number> = {};
    for (const row of countRows.results ?? []) statusCounts[row.status] = row.count;

    let sql = `
      SELECT o.id, o.agent_id, a.name AS agent_name, o.task_id, o.network, o.token,
             o.amount_atoms, o.purpose, o.status, o.action, o.available_atoms,
             o.shortfall_atoms, o.source_wallet_id, o.transaction_hash,
             o.received_output_atoms, o.settlement_note, o.created_at,
             ap.decision AS approval_decision, ap.decided_at AS approval_decided_at,
             ap.telegram_user_id AS approval_telegram_user_id,
             CASE WHEN EXISTS (
               SELECT 1 FROM reservations r
               WHERE r.operation_id = o.id AND r.status = 'active'
                 AND julianday(r.expires_at) > julianday('now')
             ) THEN 1 ELSE 0 END AS has_active_reservation
      FROM operations o
      JOIN agents a ON a.id = o.agent_id AND a.business_id = o.business_id
      LEFT JOIN telegram_operation_approvals ap ON ap.operation_id = o.id
      WHERE o.business_id = ?
    `;
    const bindings: unknown[] = [businessId];
    if (status !== null) {
      sql += " AND o.status = ?";
      bindings.push(status);
    }
    if (cursor) {
      sql += " AND (o.created_at < ? OR (o.created_at = ? AND o.id < ?))";
      bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    sql += " ORDER BY o.created_at DESC, o.id DESC LIMIT ?";
    bindings.push(limit + 1);

    const rows = await env.DB.prepare(sql).bind(...bindings).all<AdminOperationRow>();
    const page = rows.results ?? [];
    const hasMore = page.length > limit;
    const visible = hasMore ? page.slice(0, limit) : page;
    const operations = visible.map((row) => {
      const decimals = row.token === "SOL" ? 9 : 6;
      const approvalState = row.approval_decision === "approved" || row.approval_decision === "rejected"
        ? row.approval_decision
        : row.status === "reserved" && row.action === "direct_fulfillment" && row.has_active_reservation === 1
          ? "pending"
          : "not_applicable";
      return {
        operationId: row.id,
        agentId: row.agent_id,
        agentName: row.agent_name,
        taskId: row.task_id,
        network: row.network,
        token: row.token,
        amount: formatTokenAmount(BigInt(row.amount_atoms), decimals),
        purpose: row.purpose,
        status: row.status,
        action: row.action,
        available: formatTokenAmount(BigInt(row.available_atoms), decimals),
        shortfall: formatTokenAmount(BigInt(row.shortfall_atoms), decimals),
        sourceWalletId: row.source_wallet_id,
        approval: {
          state: approvalState,
          decidedAt: row.approval_decided_at,
          decidedByTelegramUserId: row.approval_telegram_user_id
        },
        execution: {
          transactionHash: row.transaction_hash
        },
        settlement: {
          receivedUSDC: row.received_output_atoms
            ? formatTokenAmount(BigInt(row.received_output_atoms), 6)
            : null,
          note: row.settlement_note,
          status: row.status
        },
        createdAt: row.created_at
      };
    });

    const last = visible[visible.length - 1];
    const nextCursor = hasMore && last
      ? btoa(JSON.stringify({ createdAt: last.created_at, id: last.id }))
      : null;

    return json({ operations, statusCounts, nextCursor, limit });
  } catch {
    return json({ error: "internal_error" }, 500);
  }
}

async function listAgentOperations(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const rows = await env.DB.prepare(`
    SELECT o.id, o.task_id, o.token, o.amount_atoms, o.status, o.action, o.available_atoms,
           o.shortfall_atoms, o.source_wallet_id, o.transaction_hash, o.received_output_atoms, o.created_at,
           a.decision AS telegram_decision, a.decided_at AS telegram_decided_at
    FROM operations o
    LEFT JOIN telegram_operation_approvals a ON a.operation_id = o.id
    WHERE o.agent_id = ?
    ORDER BY o.created_at DESC
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
    telegram_decision: string | null;
    telegram_decided_at: string | null;
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
      telegramDecision: row.telegram_decision,
      telegramDecidedAt: row.telegram_decided_at,
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
    await env.DB.prepare("DELETE FROM telegram_request_drafts WHERE expires_at <= datetime('now')").run();
    await env.DB.prepare("DELETE FROM telegram_processed_updates WHERE processed_at < datetime('now', '-30 days')").run();
    await env.DB.prepare("DELETE FROM api_rate_limits WHERE updated_at < datetime('now', '-2 days')").run();
    await env.DB.prepare("DELETE FROM wallet_ownership_challenges WHERE expires_at < datetime('now', '-1 day') OR consumed_at < datetime('now', '-1 day')").run();
    await env.DB.prepare(`
      DELETE FROM x402_payment_challenges
      WHERE status = 'expired' AND created_at < datetime('now', '-30 days')
        AND NOT EXISTS (SELECT 1 FROM x402_payment_reservations r WHERE r.challenge_id = x402_payment_challenges.id)
    `).run();
    await deliverTelegramOutbox(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/pixel-field.svg") {
      return new Response(pixelFieldSvg, {
        headers: {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "x-content-type-options": "nosniff"
        }
      });
    }
    if (request.method === "GET" && (url.pathname === "/privacy" || url.pathname === "/terms")) {
      const page = url.pathname === "/privacy" ? privacyHtml : termsHtml;
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
        }
      });
    }
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
          telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
          telegramSupportConfigured: Boolean(telegramSupportMarkup(env))
        });
      } catch {
        return json({
          service: "nerith-api",
          status: "degraded",
          database: "unavailable"
        }, 503);
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/admin/session") return getCurrentAdminSession(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/session") return createAdminSession(request, env);
    if (request.method === "DELETE" && url.pathname === "/v1/admin/session") return endAdminSession(request, env);
    if (request.method === "POST" && url.pathname === "/v1/auth/telegram/consume") return consumeTelegramLoginTicket(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/workspace") return getBusinessWorkspace(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/operations") return getAdminBusinessOperations(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/forecast") return getAdminBusinessForecast(request, env);
    if ((request.method === "GET" || request.method === "POST") && url.pathname === "/v1/admin/x402/budgets") return manageX402Budgets(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/x402/reconcile") return reconcileX402PaymentAdmin(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") return bootstrapBusiness(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/agents") return provisionAgent(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/agents") return listBusinessAgents(request, env);
    const rotateAgentMatch = url.pathname.match(/^\/v1\/admin\/agents\/([a-zA-Z0-9_-]+)\/rotate-key$/);
    if (request.method === "POST" && rotateAgentMatch) return rotateAgentKey(request, env, rotateAgentMatch[1]);
    const disableAgentMatch = url.pathname.match(/^\/v1\/admin\/agents\/([a-zA-Z0-9_-]+)\/disable$/);
    if (request.method === "POST" && disableAgentMatch) return disableAgent(request, env, disableAgentMatch[1]);
    const disableWalletMatch = url.pathname.match(/^\/v1\/admin\/wallets\/([a-zA-Z0-9_-]+)\/disable$/);
    if (request.method === "POST" && disableWalletMatch) return disableWallet(request, env, disableWalletMatch[1]);
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/test") return sendTelegramTestAlert(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/telegram/connections") return listTelegramConnections(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/permissions") return updateTelegramPermission(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/telegram/status") return getTelegramWebhookStatus(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/setup") return configureTelegramWebhook(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/link-codes") return createTelegramLinkCode(request, env);
    if (request.method === "POST" && url.pathname === "/v1/telegram/webhook") return telegramWebhook(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/wallets") return listBusinessWallets(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/wallet-roles") return listBusinessWalletRoles(request, env);
    if (request.method === "GET" && url.pathname === "/v1/admin/payment-policy") return getBusinessPaymentPolicy(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/payment-policy") return setBusinessPaymentPolicy(request, env);
    if (request.method === "POST" && url.pathname === "/v1/payments/prepare") return createBusinessPaymentIntent(request, env);
    const finalPaymentPrepareRoute = url.pathname.match(/^\/v1\/admin\/payment-intents\/([a-zA-Z0-9_-]+)\/prepare-final-payment$/);
    if (request.method === "POST" && finalPaymentPrepareRoute) {
      return prepareFinalPaymentAfterReplenishment(request, env, finalPaymentPrepareRoute[1]);
    }
    const fundingLegRoute = url.pathname.match(/^\/v1\/admin\/payment-intents\/([a-zA-Z0-9_-]+)\/funding-legs\/([a-zA-Z0-9_-]+)\/(submit|reconcile)$/);
    if (request.method === "POST" && fundingLegRoute && fundingLegRoute[3] === "submit") {
      return submitFundingLegTransaction(request, env, fundingLegRoute[1], fundingLegRoute[2]);
    }
    if (request.method === "POST" && fundingLegRoute && fundingLegRoute[3] === "reconcile") {
      return reconcileFundingLegTransaction(request, env, fundingLegRoute[1], fundingLegRoute[2]);
    }
    const paymentIntentMatch = url.pathname.match(/^\/v1\/payments\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && paymentIntentMatch) return getBusinessPaymentIntent(request, env, paymentIntentMatch[1]);
    if (request.method === "POST" && url.pathname === "/v1/admin/wallet-roles") return setBusinessWalletRole(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/wallet-ownership/challenge") return createWalletOwnershipChallenge(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/wallet-ownership/verify") return verifyWalletOwnership(request, env);
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
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/control" || url.pathname === "/dashboard")) {
      const page = url.pathname === "/app" ? dashboardHtml : url.pathname === "/control" ? controlHtml : url.pathname === "/dashboard" ? businessDashboardHtml : landingHtml;
      return new Response(page, {
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
