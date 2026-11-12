import { describe, expect, it } from "vitest";
import worker from "../src/index";

type QueryRecord = { sql: string; values: unknown[] };
type TestEnv = { DB: D1Database; ADMIN_BOOTSTRAP_TOKEN?: string };

function makeEnv(options: {
  businessExists?: boolean;
  throwOn?: string;
  cookieSessionValid?: boolean;
} = {}) {
  const queries: QueryRecord[] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) {
          values = args;
          return statement;
        },
        async first<T>() {
          queries.push({ sql, values });
          if (options.throwOn && sql.includes(options.throwOn)) throw new Error("database internals must not escape");
          if (sql.includes("FROM admin_sessions")) {
            return (options.cookieSessionValid ? { token_hash: "session" } : null) as T | null;
          }
          if (sql.includes("FROM businesses")) {
            return (options.businessExists === false ? null : { id: values[0] }) as T | null;
          }
          return null;
        },
        async all<T>() {
          queries.push({ sql, values });
          if (options.throwOn && sql.includes(options.throwOn)) throw new Error("database internals must not escape");
          return { results: [] as T[] };
        },
        async run() {
          queries.push({ sql, values });
          return { success: true, meta: { changes: 0 } };
        }
      };
      return statement;
    }
  };
  return { env: { DB: db } as unknown as TestEnv, queries };
}

const token = "dashboard-test-bootstrap-token";
const bearer = { authorization: `Bearer ${token}` };
const sessionCookie = "nerith_admin_session=" + "a".repeat(64);

async function call(path: string, env: TestEnv, headers: HeadersInit = {}) {
  const request = new Request("https://nerith.test" + path, { headers });
  return worker.fetch(request, { ...env, ADMIN_BOOTSTRAP_TOKEN: token } as TestEnv);
}

describe("admin dashboard read endpoints", () => {
  it("requires an admin session before checking business identifiers", async () => {
    const { env } = makeEnv();
    const response = await call("/v1/admin/operations", env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects malformed and expired session cookies", async () => {
    const malformed = makeEnv();
    const malformedResponse = await call("/v1/admin/forecast?businessId=biz_1", malformed.env, {
      cookie: "nerith_admin_session=not-a-token"
    });
    expect(malformedResponse.status).toBe(401);

    const expired = makeEnv({ cookieSessionValid: false });
    const expiredResponse = await call("/v1/admin/forecast?businessId=biz_1", expired.env, {
      cookie: sessionCookie
    });
    expect(expiredResponse.status).toBe(401);
  });

  it("accepts the existing HttpOnly admin session cookie", async () => {
    const { env } = makeEnv({ cookieSessionValid: true });
    const response = await call("/v1/admin/operations?businessId=biz_1", env, { cookie: sessionCookie });
    expect(response.status).toBe(200);
  });

  it("requires businessId after authorization", async () => {
    const { env } = makeEnv();
    const response = await call("/v1/admin/operations", env, bearer);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "business_id_required" });
  });

  it("returns 404 for an unknown business", async () => {
    const { env } = makeEnv({ businessExists: false });
    const response = await call("/v1/admin/forecast?businessId=missing", env, bearer);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "business_not_found" });
  });

  it("returns an empty, honest business forecast and excludes api-payment wallets", async () => {
    const { env, queries } = makeEnv();
    const response = await call("/v1/admin/forecast?businessId=biz_1", env, bearer);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.wallets).toEqual([]);
    expect(body.obligations).toEqual([]);
    expect(body.walletsObserved).toBe(0);
    expect(body.businessBalanceDataFresh).toBe(false);
    expect(body.summary).toEqual({
      planned: 0,
      covered: 0,
      conversionRequired: 0,
      blocked: 0,
      totalShortfallUSDC: "0"
    });
    const balanceQuery = queries.find(query => query.sql.includes("FROM wallets w") && query.sql.includes("wallet_balances"));
    expect(balanceQuery?.sql).toContain("w.purpose = 'operating'");
    expect(balanceQuery?.sql).toContain("w.network = 'solana'");
    expect(balanceQuery?.values).toEqual(["biz_1"]);
  });

  it("scopes operations and counts to the requested business", async () => {
    const { env, queries } = makeEnv();
    const response = await call("/v1/admin/operations?businessId=biz_alpha", env, bearer);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operations: [], statusCounts: {}, nextCursor: null, limit: 50 });
    const countQuery = queries.find(query => query.sql.includes("COUNT(*) AS count FROM operations"));
    const listQuery = queries.find(query => query.sql.includes("FROM operations o"));
    expect(countQuery?.sql).toContain("WHERE business_id = ?");
    expect(countQuery?.values).toEqual(["biz_alpha"]);
    expect(listQuery?.sql).toContain("WHERE o.business_id = ?");
    expect(listQuery?.values[0]).toBe("biz_alpha");
  });

  it("validates limit, status and cursor parameters", async () => {
    const { env } = makeEnv();
    for (const suffix of ["&limit=0", "&limit=101", "&limit=abc", "&status=made-up", "&cursor=not-base64"]) {
      const response = await call("/v1/admin/operations?businessId=biz_1" + suffix, env, bearer);
      expect(response.status).toBe(400);
    }
  });

  it("does not expose database error details", async () => {
    const { env } = makeEnv({ throwOn: "FROM operations" });
    const response = await call("/v1/admin/operations?businessId=biz_1", env, bearer);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error" });
  });
});


describe("existing agent endpoints remain compatible after forecast extraction", () => {
  async function agentEnv(allRows: (sql: string) => unknown[]) {
    const apiKey = "agent-regression-fixture-key";
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const agent = { id: "agent_own", business_id: "biz_fixture", status: "active", can_use_business_treasury: 1 };
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) { values = args; return statement; },
          async first<T>() {
            if (sql.includes("api_key_hash")) return agent as T;
            return null;
          },
          async all<T>() { return { results: allRows(sql) as T[] }; },
          async run() { return { success: true, meta: { changes: 0 } }; }
        };
        return statement;
      }
    };
    return { apiKey, hash, env: { DB: db as unknown as D1Database } as TestEnv };
  }

  it("preserves the agent forecast response for a seeded shared-wallet fixture", async () => {
    const ownDue = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const otherDue = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const observedAt = new Date().toISOString();
    const fixture = await agentEnv(sql => {
      if (sql.includes("FROM wallets w") && sql.includes("wallet_balances")) return [
        { wallet_id: "w-business", address: "So11111111111111111111111111111111111111112", scope: "business", agent_id: null, token: "USDC", confirmed_atoms: "50000000", reserved_atoms: "10000000", observed_at: observedAt },
        { wallet_id: "w-business", address: "So11111111111111111111111111111111111111112", scope: "business", agent_id: null, token: "SOL", confirmed_atoms: "1000000000", reserved_atoms: "0", observed_at: observedAt }
      ];
      if (sql.includes("FROM liquidity_obligations o")) return [
        { agent_id: "agent_own", agent_name: "Primary Agent", task_id: "task-own", amount_atoms: "30000000", due_at: ownDue, purpose: "Own obligation", can_use_business_treasury: 1 },
        { agent_id: "agent_other", agent_name: "Second Agent", task_id: "task-other", amount_atoms: "20000000", due_at: otherDue, purpose: "Other obligation", can_use_business_treasury: 1 }
      ];
      return [];
    });
    const response = await worker.fetch(new Request("https://nerith.test/v1/liquidity/forecast", {
      headers: { authorization: "Bearer " + fixture.apiKey }
    }), fixture.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      windowDays: 30,
      balanceDataFresh: true,
      businessBalanceDataFresh: true,
      walletsObserved: 1,
      obligations: [{
        taskId: "task-own",
        dueAt: ownDue,
        purpose: "Own obligation",
        amountUSDC: "30",
        availableUSDC: "40",
        shortfallUSDC: "0",
        status: "covered",
        sourceWalletId: "w-business",
        sourceAsset: null
      }],
      summary: { planned: 1, covered: 1, conversionRequired: 0, blocked: 0, totalShortfallUSDC: "0" },
      businessSummary: { planned: 2, covered: 1, conversionRequired: 1, blocked: 0, totalShortfallUSDC: "10", otherAgentObligations: 1 },
      note: "Business-wide forecast allocates shared business wallets across all agents in due-date order. Private wallets remain agent-isolated. Conversion availability is indicative until a live Swap.io quote is obtained; no future funds are reserved."
    });
  });

  it("preserves the existing agent operations response shape", async () => {
    const fixture = await agentEnv(sql => {
      if (sql.includes("FROM operations o") && sql.includes("LEFT JOIN telegram_operation_approvals")) return [{
        id: "op_fixture",
        task_id: "task_fixture",
        token: "USDC",
        amount_atoms: "12500000",
        status: "completed",
        action: "direct_fulfillment",
        available_atoms: "12000000",
        shortfall_atoms: "500000",
        source_wallet_id: "wallet_fixture",
        transaction_hash: "signature_fixture",
        received_output_atoms: "11900000",
        created_at: "2026-11-12 10:00:00",
        telegram_decision: null,
        telegram_decided_at: null
      }];
      return [];
    });
    const response = await worker.fetch(new Request("https://nerith.test/v1/operations", {
      headers: { authorization: "Bearer " + fixture.apiKey }
    }), fixture.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operations: [{
        operationId: "op_fixture",
        taskId: "task_fixture",
        token: "USDC",
        amount: "12.5",
        status: "completed",
        action: "direct_fulfillment",
        available: "12",
        shortfall: "0.5",
        sourceWalletId: "wallet_fixture",
        transactionHash: "signature_fixture",
        receivedUSDC: "11.9",
        telegramDecision: null,
        telegramDecidedAt: null,
        createdAt: "2026-11-12 10:00:00"
      }]
    });
  });
});


describe("business operations aggregation and dashboard route", () => {
  it("separates pending approval from execution and settlement across agents", async () => {
    const now = "2026-11-12 10:00:00";
    const rows = [
      {
        id: "op_pending", agent_id: "agent_a", agent_name: "Agent A", task_id: "task_a",
        network: "solana", token: "USDC", amount_atoms: "10000000", purpose: "Task funding",
        status: "reserved", action: "direct_fulfillment", available_atoms: "10000000",
        shortfall_atoms: "0", source_wallet_id: "wallet_business", transaction_hash: null,
        received_output_atoms: null, settlement_note: null, created_at: now,
        approval_decision: null, approval_decided_at: null, approval_telegram_user_id: null,
        has_active_reservation: 1
      },
      {
        id: "op_completed", agent_id: "agent_b", agent_name: "Agent B", task_id: "task_b",
        network: "solana", token: "USDC", amount_atoms: "5000000", purpose: "Agent reported done",
        status: "completed", action: "direct_fulfillment", available_atoms: "5000000",
        shortfall_atoms: "0", source_wallet_id: "wallet_agent", transaction_hash: "sig_completed",
        received_output_atoms: null, settlement_note: null, created_at: "2026-11-12 09:00:00",
        approval_decision: null, approval_decided_at: null, approval_telegram_user_id: null,
        has_active_reservation: 0
      }
    ];
    const queries: QueryRecord[] = [];
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) { values = args; return statement; },
          async first<T>() {
            queries.push({ sql, values });
            if (sql.includes("FROM businesses")) return { id: values[0] } as T;
            return null;
          },
          async all<T>() {
            queries.push({ sql, values });
            if (sql.includes("COUNT(*) AS count FROM operations")) {
              return { results: [{ status: "reserved", count: 1 }, { status: "completed", count: 1 }] as T[] };
            }
            if (sql.includes("FROM operations o")) return { results: rows as T[] };
            return { results: [] as T[] };
          },
          async run() { return { success: true, meta: { changes: 0 } }; }
        };
        return statement;
      }
    };
    const env = { DB: db as unknown as D1Database, ADMIN_BOOTSTRAP_TOKEN: token } as TestEnv;
    const response = await worker.fetch(new Request("https://nerith.test/v1/admin/operations?businessId=biz_shared&limit=1", { headers: bearer }), env);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, any>;
    expect(body.operations).toHaveLength(1);
    expect(body.operations[0]).toMatchObject({
      operationId: "op_pending",
      agentId: "agent_a",
      agentName: "Agent A",
      approval: { state: "pending", decidedAt: null, decidedByTelegramUserId: null },
      execution: { transactionHash: null },
      settlement: { receivedUSDC: null, note: null, status: "reserved" }
    });
    expect(body.statusCounts).toEqual({ reserved: 1, completed: 1 });
    expect(body.nextCursor).toBeTruthy();
    expect(queries.some(q => q.sql.includes("EXISTS (") && q.sql.includes("FROM reservations r"))).toBe(true);
  });

  it("serves the dashboard with the existing restrictive page headers", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request("https://nerith.test/dashboard"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    const html = await response.text();
    expect(html).toContain("Operator-managed preview");
    expect(html).toContain("Forecasts");
    expect(html).toContain("x402 payment reserve");
    expect(html).toContain("@media(max-width:900px)");
    expect(html).toContain("@media(max-width:560px)");
    expect(html).toContain("@media(max-width:360px)");
    expect(html).toContain("bottom-nav");
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain("Read about NERITH ↗");
    expect(html).not.toContain("Need help? Visit NERITH support");
    expect(html).toContain('true,"business"');
    expect(html).toContain('true,"agent"');
    expect(html).toContain("isolated by agent, not pooled");
    expect(html).toContain("let total=0n");
    expect(html).toContain("parseDecimalAtoms(balance[field],decimals)");
    expect(html).not.toContain("Number(balance[field]");
    expect(html).toContain("amountText(b.confirmed,b.token)");
    expect(html).toContain("<option>verification_pending</option>");
  });
});


it("serves the shared pixel field as a same-origin SVG asset", async () => {
  const { env } = makeEnv();
  const response = await worker.fetch(new Request("https://nerith.test/pixel-field.svg"), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("image/svg+xml");
  expect(await response.text()).toContain("<svg");
});


it("serves the redesigned landing page without hardcoded example balances", async () => {
  const { env } = makeEnv();
  const response = await worker.fetch(new Request("https://nerith.test/"), env);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Keep autonomous agents");
  expect(html).toContain("Task amount and target asset");
  expect(html).toContain("Fresh eligible balance assessment");
  expect(html).not.toContain("10 USDC required");
  expect(html).not.toContain("2 USDC available");
});


describe("public legal pages and shared footer navigation", () => {
  it("serves the privacy overview with no external scripts or data collection forms", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request("https://nerith.test/privacy"), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).toContain("Information processed");
    expect(html).toContain("Agent API credentials");
    expect(html).toContain("does not sell personal information");
    expect(html).toContain('href="/terms"');
    expect(html).not.toContain("<script");
  });

  it("serves terms covering custody, signing and third-party risks", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request("https://nerith.test/terms"), env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("No custody or signing service");
    expect(html).toContain("business-controlled signer");
    expect(html).toContain("Third-party services and networks");
    expect(html).toContain('href="/privacy"');
  });

  it("returns 404 for unknown legal routes", async () => {
    const { env } = makeEnv();
    const response = await worker.fetch(new Request("https://nerith.test/legal"), env);
    expect(response.status).toBe(404);
  });
});

it("marks stale forecast balances and resulting shortfalls as indicative", async () => {
  const queries: QueryRecord[] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM businesses")) return { id: values[0] } as T;
          return null;
        },
        async all<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM wallets w") && sql.includes("wallet_balances")) return {
            results: [{
              wallet_id: "w_stale", address: "So11111111111111111111111111111111111111112",
              scope: "business", agent_id: null, token: "USDC", confirmed_atoms: "90000000",
              reserved_atoms: "10000000", observed_at: "2020-01-01T00:00:00.000Z"
            }] as T[]
          };
          if (sql.includes("FROM liquidity_obligations o")) return {
            results: [{
              agent_id: "agent_a", agent_name: "Agent A", task_id: "task_stale",
              amount_atoms: "5000000", due_at: "2026-11-13T10:00:00.000Z",
              purpose: "Stale balance fixture", can_use_business_treasury: 1
            }] as T[]
          };
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
  const env = { DB: db as unknown as D1Database, ADMIN_BOOTSTRAP_TOKEN: token } as TestEnv;
  const response = await worker.fetch(new Request("https://nerith.test/v1/admin/forecast?businessId=biz_stale", { headers: bearer }), env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.businessBalanceDataFresh).toBe(false);
  expect(body.wallets).toEqual([{
    walletId: "w_stale",
    address: "So11111111111111111111111111111111111111112",
    scope: "business",
    agentId: null,
    usdcFresh: false,
    solFresh: false
  }]);
  expect(body.obligations[0]).toMatchObject({
    status: "blocked",
    availableUSDC: "0",
    shortfallUSDC: "5"
  });
  expect(body.confidence).toBe("not_available");
  const walletQuery = queries.find(q => q.sql.includes("FROM wallets w") && q.sql.includes("wallet_balances"));
  expect(walletQuery?.values).toEqual(["biz_stale"]);
  expect(walletQuery?.sql).toContain("w.purpose = 'operating'");
  expect(walletQuery?.sql).not.toContain("api_payment");
});


it("returns all active agents' obligations in the business forecast", async () => {
  const observedAt = new Date().toISOString();
  const dueA = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const dueB = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const queries: QueryRecord[] = [];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM businesses")) return { id: values[0] } as T;
          return null;
        },
        async all<T>() {
          queries.push({ sql, values });
          if (sql.includes("FROM wallets w") && sql.includes("wallet_balances")) return {
            results: [
              { wallet_id: "w_shared", address: "So11111111111111111111111111111111111111112", scope: "business", agent_id: null, token: "USDC", confirmed_atoms: "50000000", reserved_atoms: "10000000", observed_at: observedAt },
              { wallet_id: "w_shared", address: "So11111111111111111111111111111111111111112", scope: "business", agent_id: null, token: "SOL", confirmed_atoms: "1000000000", reserved_atoms: "0", observed_at: observedAt }
            ] as T[]
          };
          if (sql.includes("FROM liquidity_obligations o")) return {
            results: [
              { agent_id: "agent_a", agent_name: "Agent A", task_id: "task_a", amount_atoms: "30000000", due_at: dueA, purpose: "First obligation", can_use_business_treasury: 1 },
              { agent_id: "agent_b", agent_name: "Agent B", task_id: "task_b", amount_atoms: "20000000", due_at: dueB, purpose: "Second obligation", can_use_business_treasury: 1 }
            ] as T[]
          };
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
  const env = { DB: db as unknown as D1Database, ADMIN_BOOTSTRAP_TOKEN: token } as TestEnv;
  const response = await worker.fetch(new Request("https://nerith.test/v1/admin/forecast?businessId=biz_multi", { headers: bearer }), env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.obligations).toHaveLength(2);
  expect(body.obligations.map((o: any) => [o.agentId, o.agentName, o.status])).toEqual([
    ["agent_a", "Agent A", "covered"],
    ["agent_b", "Agent B", "conversion_required"]
  ]);
  expect(body.summary).toEqual({
    planned: 2, covered: 1, conversionRequired: 1, blocked: 0, totalShortfallUSDC: "10"
  });
  expect(body.wallets).toHaveLength(1);
  expect(body.wallets[0]).toMatchObject({ scope: "business", usdcFresh: true, solFresh: true });
  expect(body.confidence).toBe("not_available");
  expect(body.truncated).toBe(false);
  expect(queries.filter(q => q.sql.includes("business_id = ?")).every(q => q.values.includes("biz_multi"))).toBe(true);
});


it("returns approval, execution and verified settlement as separate operation states", async () => {
  const row = {
    id: "op_settled", agent_id: "agent_a", agent_name: "Agent A", task_id: "task_settled",
    network: "solana", token: "USDC", amount_atoms: "10000000", purpose: "Approved conversion",
    status: "conversion_settled", action: "conversion_required", available_atoms: "2000000",
    shortfall_atoms: "8000000", source_wallet_id: "wallet_a", transaction_hash: "solana_signature",
    received_output_atoms: "9500000", settlement_note: "Verified finalized output",
    created_at: "2026-11-12 10:00:00", approval_decision: "approved",
    approval_decided_at: "2026-11-12 09:55:00", approval_telegram_user_id: "telegram-user-42",
    has_active_reservation: 0
  };
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...args: unknown[]) { values = args; return statement; },
        async first<T>() { return sql.includes("FROM businesses") ? { id: values[0] } as T : null; },
        async all<T>() {
          if (sql.includes("COUNT(*) AS count FROM operations")) return { results: [{ status: "conversion_settled", count: 1 }] as T[] };
          if (sql.includes("FROM operations o")) return { results: [row] as unknown as T[] };
          return { results: [] as T[] };
        },
        async run() { return { success: true, meta: { changes: 0 } }; }
      };
      return statement;
    }
  };
  const env = { DB: db as unknown as D1Database, ADMIN_BOOTSTRAP_TOKEN: token } as TestEnv;
  const response = await worker.fetch(new Request("https://nerith.test/v1/admin/operations?businessId=biz_settled", { headers: bearer }), env);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(body.operations[0]).toMatchObject({
    approval: { state: "approved", decidedByTelegramUserId: "telegram-user-42" },
    execution: { transactionHash: "solana_signature" },
    settlement: { receivedUSDC: "9.5", note: "Verified finalized output", status: "conversion_settled" }
  });
});


describe("browser page script syntax", () => {
  it("parses the inline scripts served for the landing page and business dashboard", async () => {
    const { env } = makeEnv();
    for (const path of ["/", "/dashboard"]) {
      const response = await worker.fetch(new Request("https://nerith.test" + path), env);
      const html = await response.text();
      const match = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(match).not.toBeNull();
      expect(() => new Function(match![1])).not.toThrow();
      if (path === "/dashboard") {
        for (const breakpoint of [1100, 900, 560, 360]) {
          expect(html).toContain("@media(max-width:" + breakpoint + "px)");
        }
        expect(html).toContain('.table-wrap{width:100%;overflow-x:auto');
        expect(html).toContain("drawer-backdrop.open");
        expect(html).toContain('id="drawerBackdrop"');
        expect(html).toContain("prefers-reduced-motion:reduce");
      }
    }
  });
});
