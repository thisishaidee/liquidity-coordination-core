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
  ASSETS?: { fetch(request: Request): Promise<Response> };
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
    "SELECT id, status, shortfall_atoms, source_reservation_id FROM operations WHERE id = ? AND agent_id = ? AND action = 'conversion_required' LIMIT 1"
  ).bind(operationId, agent.id).first<{
    id: string;
    status: string;
    shortfall_atoms: string;
    source_reservation_id: string | null;
  }>();
  if (!operation) return json({ error: "conversion_operation_not_found" }, 404);

  const isAwaiting = operation.status === "awaiting_conversion";
  const isPreparing = allowPreparing && operation.status === "preparing_conversion";
  if (!isAwaiting && !isPreparing) {
    return json({ error: "operation_not_ready_for_conversion", status: operation.status }, 409);
  }

  const wallet = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.address, b.confirmed_atoms, b.reserved_atoms, b.observed_at
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id AND b.token = 'SOL'
    WHERE w.business_id = ? AND w.network = 'solana' AND w.address = ? AND w.status = 'active' AND w.purpose = 'operating'
      AND (
        (w.scope = 'agent' AND w.agent_id = ?) OR
        (w.scope = 'business' AND ? = 1)
      )
    LIMIT 1
  `).bind(agent.business_id, userAddress, agent.id, agent.can_use_business_treasury).first<{
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
    sourceReservationId: operation.source_reservation_id
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
  return new Response(await upstream.arrayBuffer(), {
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

  return proxyHermes(request, "/v1/swap/quote", {
    input: { token: SOL_MINT, amount: context.sourceAtoms.toString(), chainKey: "sol" },
    output: { token: USDC_MINT, chainKey: "sol" },
    userAddress: context.userAddress,
    slippageBps
  }, {
    "X-Liquidity-Operation-ID": context.operationId,
    "X-Liquidity-Required-USDC": formatTokenAmount(context.shortfallAtoms, 6)
  });
}

async function prepareSwapTransaction(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_json" }, 400);

  const context = await validateConversionContext(agent, body, env, true);
  if (context instanceof Response) return context;
  if (typeof body.provider !== "string" || body.provider.length < 1 || body.provider.length > 100) {
    return json({ error: "invalid_provider" }, 400);
  }
  if (!body.providerQuote || typeof body.providerQuote !== "object" || Array.isArray(body.providerQuote)) {
    return json({ error: "invalid_provider_quote" }, 400);
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
          SET status = 'preparing_conversion', source_reservation_id = ?, provider_key = ?
          WHERE id = ? AND status = 'awaiting_conversion'
        `).bind(reservationId, body.provider, context.operationId)
      ]);
      const refreshed = await env.DB.prepare(
        "SELECT source_reservation_id FROM operations WHERE id = ? AND status = 'preparing_conversion'"
      ).bind(context.operationId).first<{ source_reservation_id: string | null }>();
      if (refreshed?.source_reservation_id !== reservationId) throw new Error("Operation was claimed by another prepare request");
    } catch {
      await env.DB.prepare(
        "UPDATE wallet_balances SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - ? WHERE id = ? AND CAST(reserved_atoms AS INTEGER) >= ?"
      ).bind(context.sourceAtoms.toString(), context.walletBalanceId, context.sourceAtoms.toString()).run();
      await env.DB.prepare("DELETE FROM reservations WHERE id = ? AND status = 'active'").bind(reservationId).run();
      return json({ error: "source_reservation_failed" }, 409);
    }
  } else {
    await env.DB.prepare(
      "UPDATE operations SET provider_key = ? WHERE id = ? AND status = 'preparing_conversion'"
    ).bind(body.provider, context.operationId).run();
  }

  return proxyHermes(request, "/v1/swap/build-tx", {
    provider: body.provider,
    userAddress: context.userAddress,
    chainKey: "sol",
    quoteResponse: body.providerQuote
  }, {
    "X-Liquidity-Operation-ID": context.operationId,
    "X-Liquidity-Required-USDC": formatTokenAmount(context.shortfallAtoms, 6),
    "X-Liquidity-Source-Reserved-SOL": context.sourceAmount
  });
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

  await notifyBusiness(
    env,
    agent.business_id,
    decision.action === "conversion_required"
      ? `Liquidity shortfall: task ${taskId} needs ${formatTokenAmount(decision.shortfallAtoms)} additional USDC. Eligible source assets: ${decision.eligibleSourceTokens.join(", ") || "none"}. Operation ${operationId}.`
      : `Liquidity blocked: task ${taskId} has insufficient authorized funds. Operation ${operationId}.`
  );

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
  if (operation.status !== "reserved" && operation.status !== "preparing_conversion") {
    return json({ error: "operation_not_releasable", status: operation.status }, 409);
  }

  const reservation = await env.DB.prepare(
    "SELECT id, wallet_balance_id, amount_atoms, token FROM reservations WHERE operation_id = ? AND status = 'active' LIMIT 1"
  ).bind(operationId).first<{ id: string; wallet_balance_id: string; amount_atoms: string; token: string }>();
  if (!reservation) return json({ error: "active_reservation_not_found" }, 409);

  const amount = BigInt(reservation.amount_atoms);
  const previousStatus = operation.status;
  const claim = await env.DB.prepare(
    "UPDATE reservations SET status = 'released', released_at = datetime('now') WHERE id = ? AND status = 'active'"
  ).bind(reservation.id).run();
  if ((claim.meta?.changes ?? 0) !== 1) return json({ error: "reservation_already_released" }, 409);

  const operationClaim = await env.DB.prepare(
    "UPDATE operations SET status = 'released' WHERE id = ? AND status = ?"
  ).bind(operationId, previousStatus).run();
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
      env.DB.prepare("UPDATE operations SET status = ? WHERE id = ? AND status = 'released'")
        .bind(previousStatus, operationId)
    ]);
    return json({ error: "reservation_ledger_mismatch" }, 409);
  }

  await notifyBusiness(
    env,
    agent.business_id,
    `Reservation released for operation ${operationId}: ${formatTokenAmount(amount, reservation.token === "SOL" ? 9 : 6)} ${reservation.token}.`
  );

  return json({
    operationId,
    status: "released",
    releasedAmount: formatTokenAmount(amount, reservation.token === "SOL" ? 9 : 6),
    token: reservation.token
  });
}

async function expireReservations(env: Env): Promise<{ expired: number; skipped: number }> {
  const due = await env.DB.prepare(`
    SELECT r.id, r.operation_id, r.wallet_balance_id, r.amount_atoms, r.token, o.business_id
    FROM reservations r
    JOIN operations o ON o.id = r.operation_id
    WHERE r.status = 'active'
      AND o.status IN ('reserved', 'preparing_conversion')
      AND julianday(r.expires_at) <= julianday('now')
    ORDER BY r.expires_at ASC
    LIMIT 100
  `).all<{ id: string; operation_id: string; wallet_balance_id: string; amount_atoms: string; token: string; business_id: string }>();

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
      "UPDATE operations SET status = 'expired' WHERE id = ? AND status IN ('reserved', 'preparing_conversion')"
    ).bind(reservation.operation_id).run();
    await notifyBusiness(
      env,
      reservation.business_id,
      `Reservation expired for operation ${reservation.operation_id}. The held ${formatTokenAmount(amount, reservation.token === "SOL" ? 9 : 6)} ${reservation.token} is available again.`
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
    "UPDATE operations SET status = 'conversion_submitted', transaction_hash = ? WHERE id = ? AND status = 'preparing_conversion'"
  ).bind(transactionHash, operationId).run();
  if ((update.meta?.changes ?? 0) !== 1) return json({ error: "operation_state_changed" }, 409);

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
    "SELECT id, status, transaction_hash, source_reservation_id, shortfall_atoms, received_output_atoms, settlement_note FROM operations WHERE id = ? AND agent_id = ?"
  ).bind(operationId, agent.id).first<{
    id: string;
    status: string;
    transaction_hash: string | null;
    source_reservation_id: string | null;
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

  let upstream: Response;
  try {
    const url = new URL("https://hermes.swap.io/v1/swap/status");
    url.searchParams.set("chainKey", "sol");
    url.searchParams.set("id", operation.transaction_hash);
    upstream = await fetch(url.toString(), { method: "GET" });
  } catch {
    return json({ error: "swap_status_unavailable" }, 502);
  }
  if (!upstream.ok) return json({ error: "swap_status_upstream_error", upstreamStatus: upstream.status }, 502);

  const payload = await upstream.json() as Record<string, unknown>;
  const swapStatus = payload.status;
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
      transaction?: { message?: { accountKeys?: Array<string | { pubkey?: string }> } };
      meta?: {
        err?: unknown;
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
      const keyIndex = keys.findIndex((entry) =>
        (typeof entry === "string" ? entry : entry.pubkey) === wallet.address
      );
      const preLamports = transaction.meta.preBalances?.[keyIndex];
      const postLamports = transaction.meta.postBalances?.[keyIndex];
      const nativeSpent = keyIndex >= 0 && preLamports !== undefined && postLamports !== undefined
        ? BigInt(preLamports) - BigInt(postLamports)
        : 0n;

      const sumOwnerUsdc = (entries: ParsedTokenBalance[] | undefined) =>
        (entries ?? []).filter((entry) => entry.owner === wallet.address && entry.mint === USDC_MINT)
          .reduce((sum, entry) => sum + BigInt(entry.uiTokenAmount?.amount ?? "0"), 0n);

      const beforeUsdc = sumOwnerUsdc(transaction.meta.preTokenBalances);
      const afterUsdc = sumOwnerUsdc(transaction.meta.postTokenBalances);
      outputAtoms = afterUsdc > beforeUsdc ? afterUsdc - beforeUsdc : 0n;

      if (nativeSpent < BigInt(reservation.amount_atoms) || outputAtoms === 0n) {
        effectiveStatus = "unverified";
        settlementNote = "The finalized transaction could not be verified as the expected SOL-to-USDC conversion for the registered wallet.";
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

  await env.DB.prepare(
    "UPDATE operations SET status = ?, received_output_atoms = ?, settlement_note = ? WHERE id = ? AND status = 'conversion_submitted'"
  ).bind(nextStatus, outputAtoms.toString(), settlementNote, operationId).run();

  await notifyBusiness(
    env,
    agent.business_id,
    `Conversion update for ${operationId}: ${nextStatus}. ${outputAtoms > 0n ? formatTokenAmount(outputAtoms, 6) + " USDC received." : ""}`
  );

  return json({
    operationId,
    transactionHash: operation.transaction_hash,
    swapStatus,
    operationStatus: nextStatus,
    receivedUSDC: outputAtoms > 0n ? formatTokenAmount(outputAtoms, 6) : null,
    requiredUSDC: formatTokenAmount(BigInt(operation.shortfall_atoms), 6),
    settlementNote,
    balanceRefreshRequired: effectiveStatus !== "failed"
  });
}

async function getAgentLiquidity(request: Request, env: Env): Promise<Response> {
  const agent = await authenticate(request, env.DB);
  if (!agent || agent.status !== "active") return json({ error: "unauthorized" }, 401);

  const rows = await env.DB.prepare(`
    SELECT w.id AS wallet_id, w.address, w.scope, b.token, b.confirmed_atoms,
           b.reserved_atoms, b.observed_at, b.source
    FROM wallets w
    JOIN wallet_balances b ON b.wallet_id = w.id
    WHERE w.business_id = ? AND w.status = 'active' AND w.purpose = 'operating'
      AND w.network = 'solana'
      AND (
        (w.scope = 'agent' AND w.agent_id = ?) OR
        (w.scope = 'business' AND ? = 1)
      )
    ORDER BY w.scope, w.address, b.token
  `).bind(agent.business_id, agent.id, agent.can_use_business_treasury).all<{
    wallet_id: string;
    address: string;
    scope: string;
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
           shortfall_atoms, transaction_hash, received_output_atoms, created_at
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
           available_atoms, shortfall_atoms, transaction_hash, received_output_atoms,
           settlement_note, created_at
    FROM operations WHERE id = ? AND agent_id = ? LIMIT 1
  `).bind(operationId, agent.id).first<Record<string, string>>();
  if (!operation) return json({ error: "operation_not_found" }, 404);

  const reservation = await env.DB.prepare(
    "SELECT id, amount_atoms, status, expires_at, token FROM reservations WHERE operation_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(operationId).first<{ id: string; amount_atoms: string; status: string; expires_at: string; token: string }>();

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
    transactionHash: operation.transaction_hash ?? null,
    receivedUSDC: operation.received_output_atoms
      ? formatTokenAmount(BigInt(operation.received_output_atoms), 6)
      : null,
    settlementNote: operation.settlement_note ?? null,
    reservation: reservation ? {
      id: reservation.id,
      amount: formatTokenAmount(BigInt(reservation.amount_atoms), reservation.token === "SOL" ? 9 : 6),
      token: reservation.token,
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
      return json({
        service: "liquidity-coordination-api",
        status: "ok",
        version: "0.3.0",
        dashboard: true,
        telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET)
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/admin/bootstrap") return bootstrapBusiness(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/telegram/link-codes") return createTelegramLinkCode(request, env);
    if (request.method === "POST" && url.pathname === "/v1/telegram/webhook") return telegramWebhook(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/wallets") return registerWallet(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/balances") return upsertBalanceSnapshot(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/balances/sync") return syncSolanaBalances(request, env);
    if (request.method === "POST" && url.pathname === "/v1/admin/reservations/expire") return expireReservationsAdmin(request, env);
    if (request.method === "POST" && url.pathname === "/v1/liquidity/requests") return createLiquidityRequest(request, env);
    if (request.method === "GET" && url.pathname === "/v1/liquidity") return getAgentLiquidity(request, env);
    if (request.method === "GET" && url.pathname === "/v1/operations") return listAgentOperations(request, env);
    if (request.method === "POST" && url.pathname === "/v1/conversions/quote") return requestSwapQuote(request, env);
    if (request.method === "POST" && url.pathname === "/v1/conversions/prepare") return prepareSwapTransaction(request, env);
    if (request.method === "POST" && url.pathname === "/v1/conversions/track") return trackSwapTransaction(request, env);
    const swapStatusMatch = url.pathname.match(/^\/v1\/conversions\/status\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && swapStatusMatch) return getSwapStatus(request, env, swapStatusMatch[1]);
    const releaseMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)\/release$/);
    if (request.method === "POST" && releaseMatch) return releaseOperation(request, env, releaseMatch[1]);
    const operationMatch = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)$/);
    if (request.method === "GET" && operationMatch) return getOperation(request, env, operationMatch[1]);
    if (url.pathname.startsWith("/v1/")) return json({ error: "not_found" }, 404);
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return json({ error: "not_found" }, 404);
  }
};
