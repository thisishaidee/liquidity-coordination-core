import { describe, expect, it } from "vitest";
import { describeAdminRoute, isAllowedAdminOrigin, isDashboardRoleAllowed, matchesBusinessScope } from "../src/admin-auth";

describe("business-scoped admin route classification", () => {
  it("requires a business id for query- and body-scoped routes", () => {
    expect(describeAdminRoute("GET", "/v1/admin/workspace", new URLSearchParams(), null)).toEqual({ kind: "invalid" });
    expect(describeAdminRoute("GET", "/v1/admin/workspace", new URLSearchParams("businessId=biz_a"), null)).toEqual({ kind: "business", businessId: "biz_a" });
    expect(describeAdminRoute("POST", "/v1/admin/wallets", new URLSearchParams(), { businessId: "biz_b" })).toEqual({ kind: "business", businessId: "biz_b" });
  });

  it("rejects conflicting query and body business ids", () => {
    expect(describeAdminRoute("POST", "/v1/admin/telegram/permissions", new URLSearchParams("businessId=biz_a"), { businessId: "biz_b" })).toEqual({ kind: "invalid" });
  });

  it("binds resource-id actions to server-resolved ownership", () => {
    expect(describeAdminRoute("POST", "/v1/admin/agents/agt_123/disable", new URLSearchParams(), null)).toEqual({ kind: "business", businessId: null, resource: { table: "agents", id: "agt_123" } });
    expect(describeAdminRoute("POST", "/v1/admin/wallets/wal_123/disable", new URLSearchParams(), null)).toEqual({ kind: "business", businessId: null, resource: { table: "wallets", id: "wal_123" } });
    expect(describeAdminRoute("POST", "/v1/admin/balances", new URLSearchParams(), { walletId: "wal_123" })).toEqual({ kind: "business", businessId: null, resource: { table: "wallets", id: "wal_123" } });
    expect(describeAdminRoute("POST", "/v1/admin/x402/reconcile", new URLSearchParams(), { reservationId: "x4r_123" })).toEqual({ kind: "business", businessId: null, resource: { table: "x402_payment_reservations", id: "x4r_123" } });
  });

  it("binds wallet-role writes to the owning business wallet", () => {
    expect(describeAdminRoute("GET", "/v1/admin/wallet-roles", new URLSearchParams("businessId=biz_a"), null))
      .toEqual({ kind: "business", businessId: "biz_a" });
    expect(describeAdminRoute("GET", "/v1/admin/wallet-roles", new URLSearchParams(), null))
      .toEqual({ kind: "invalid" });
    expect(describeAdminRoute("POST", "/v1/admin/wallet-roles", new URLSearchParams(), {
      businessId: "biz_a", walletId: "wal_123", role: "reserve"
    })).toEqual({ kind: "business", businessId: "biz_a", resource: { table: "wallets", id: "wal_123" } });
  });

  it("isolates platform-wide routes behind the bootstrap token", () => {
    expect(describeAdminRoute("POST", "/v1/admin/bootstrap", new URLSearchParams(), {})).toEqual({ kind: "global" });
    expect(describeAdminRoute("POST", "/v1/admin/telegram/setup", new URLSearchParams(), {})).toEqual({ kind: "global" });
    expect(describeAdminRoute("GET", "/v1/admin/telegram/status", new URLSearchParams(), null)).toEqual({ kind: "global" });
    expect(describeAdminRoute("POST", "/v1/admin/reservations/expire", new URLSearchParams(), {})).toEqual({ kind: "global" });
    expect(describeAdminRoute("POST", "/v1/admin/telegram/setup", new URLSearchParams("businessId=biz_a"), {})).toEqual({ kind: "global" });
  });

  it("fails closed for unknown admin routes and unsupported methods", () => {
    expect(describeAdminRoute("GET", "/v1/admin/secrets", new URLSearchParams("businessId=biz_a"), null)).toEqual({ kind: "invalid" });
    expect(describeAdminRoute("DELETE", "/v1/admin/workspace", new URLSearchParams("businessId=biz_a"), null)).toEqual({ kind: "invalid" });
  });
});

describe("admin session tenant isolation", () => {
  it("allows access only when the session and resolved resource belong to the same business", () => {
    expect(matchesBusinessScope("biz_a", "biz_a")).toBe(true);
    expect(matchesBusinessScope("biz_a", "biz_b")).toBe(false);
    expect(matchesBusinessScope("biz_b", "biz_a")).toBe(false);
    expect(matchesBusinessScope(null, "biz_a")).toBe(false);
    expect(matchesBusinessScope("biz_a", null)).toBe(false);
  });
});


describe("admin request origin validation", () => {
  it("accepts the API origin and the explicitly configured Pages frontend origin", () => {
    expect(isAllowedAdminOrigin("https://api.example.workers.dev", "https://api.example.workers.dev")).toBe(true);
    expect(isAllowedAdminOrigin("https://neritth.pages.dev", "https://api.example.workers.dev", "https://neritth.pages.dev")).toBe(true);
  });

  it("rejects unconfigured, missing, and malformed origins", () => {
    expect(isAllowedAdminOrigin("https://attacker.example", "https://api.example.workers.dev", "https://neritth.pages.dev")).toBe(false);
    expect(isAllowedAdminOrigin(null, "https://api.example.workers.dev", "https://neritth.pages.dev")).toBe(false);
    expect(isAllowedAdminOrigin("not-a-url", "https://api.example.workers.dev", "https://neritth.pages.dev")).toBe(false);
  });

  it("normalizes configured origins but does not accept a different host", () => {
    expect(isAllowedAdminOrigin("https://neritth.pages.dev", "https://api.example.workers.dev", " https://neritth.pages.dev/ ")).toBe(true);
    expect(isAllowedAdminOrigin("https://neritth.pages.dev.evil.example", "https://api.example.workers.dev", "https://neritth.pages.dev")).toBe(false);
  });
});


describe("dashboard role authorization", () => {
  it("allows reads for all roles and writes only for owner and admin", () => {
    for (const role of ["owner", "admin", "analyst"]) expect(isDashboardRoleAllowed(role, "GET")).toBe(true);
    expect(isDashboardRoleAllowed("owner", "POST")).toBe(true);
    expect(isDashboardRoleAllowed("admin", "POST")).toBe(true);
    expect(isDashboardRoleAllowed("analyst", "POST")).toBe(false);
    expect(isDashboardRoleAllowed(null, "GET")).toBe(false);
    expect(isDashboardRoleAllowed("unknown", "POST")).toBe(false);
  });
});
