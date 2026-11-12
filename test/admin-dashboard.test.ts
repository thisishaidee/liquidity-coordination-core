import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";

type QueryRecord = { sql: string; values: unknown[] };

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
  return { env: { DB: db } as unknown as Env, queries };
}

const token = "dashboard-test-bootstrap-token";
const bearer = { authorization: `Bearer ${token}` };
const sessionCookie = "nerith_admin_session=" + "a".repeat(64);

async function call(path: string, env: Env, headers: HeadersInit = {}) {
  const request = new Request("https://nerith.test" + path, { headers });
  return worker.fetch(request, { ...env, ADMIN_BOOTSTRAP_TOKEN: token } as Env, {} as ExecutionContext);
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
