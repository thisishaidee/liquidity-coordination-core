import { describe, expect, it } from "vitest";
import { describeAdminRoute } from "../src/admin-auth";

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
