export type AdminResource =
  | { table: "agents" | "wallets" | "x402_payment_reservations"; id: string };

export type AdminRouteTarget =
  | { kind: "global" }
  | { kind: "business"; businessId: string | null; resource?: AdminResource }
  | { kind: "invalid" };

type Body = Record<string, unknown> | null;

export function describeAdminRoute(
  method: string,
  pathname: string,
  search: URLSearchParams,
  body: Body
): AdminRouteTarget {
  const queryBusinessId = search.get("businessId");
  const bodyBusinessId = typeof body?.businessId === "string" ? body.businessId : null;
  if (queryBusinessId && bodyBusinessId && queryBusinessId !== bodyBusinessId) return { kind: "invalid" };
  const businessId = bodyBusinessId ?? queryBusinessId;

  if (
    (method === "POST" && pathname === "/v1/admin/bootstrap") ||
    (method === "GET" && pathname === "/v1/admin/telegram/status") ||
    (method === "POST" && pathname === "/v1/admin/telegram/setup") ||
    (method === "POST" && pathname === "/v1/admin/reservations/expire")
  ) return { kind: "global" };

  if (
    (method === "GET" && ["/v1/admin/workspace", "/v1/admin/operations", "/v1/admin/forecast", "/v1/admin/agents", "/v1/admin/wallets", "/v1/admin/wallet-roles", "/v1/admin/payment-policy", "/v1/admin/payment-intents"].includes(pathname)) ||
    (method === "POST" && ["/v1/admin/agents", "/v1/admin/wallets", "/v1/admin/balances/sync", "/v1/admin/telegram/test", "/v1/admin/telegram/permissions", "/v1/admin/telegram/link-codes", "/v1/admin/payment-policy"].includes(pathname)) ||
    (method === "POST" && pathname === "/v1/admin/x402/demo/quote") ||
    ((method === "GET" || method === "POST") && pathname === "/v1/admin/x402/budgets") ||
    (method === "GET" && pathname === "/v1/admin/telegram/connections")
  ) {
    return businessId ? { kind: "business", businessId } : { kind: "invalid" };
  }

  const agentMatch = pathname.match(/^\/v1\/admin\/agents\/([a-zA-Z0-9_-]+)\/(?:rotate-key|disable)$/);
  if (method === "POST" && agentMatch) {
    return { kind: "business", businessId, resource: { table: "agents", id: agentMatch[1] } };
  }

  if (method === "POST" && ["/v1/admin/wallet-ownership/challenge", "/v1/admin/wallet-ownership/verify"].includes(pathname) && typeof body?.walletId === "string") {
    return { kind: "business", businessId, resource: { table: "wallets", id: body.walletId } };
  }

  if (method === "POST" && pathname === "/v1/admin/wallet-roles" && typeof body?.walletId === "string") {
    return { kind: "business", businessId, resource: { table: "wallets", id: body.walletId } };
  }

  const finalPaymentPrepareMatch = pathname.match(/^\/v1\/admin\/payment-intents\/([a-zA-Z0-9_-]+)\/prepare-final-payment$/);
  if (method === "POST" && finalPaymentPrepareMatch) {
    return businessId ? { kind: "business", businessId } : { kind: "invalid" };
  }

  const fundingLegMatch = pathname.match(/^\/v1\/admin\/payment-intents\/([a-zA-Z0-9_-]+)\/funding-legs\/([a-zA-Z0-9_-]+)\/(prepare|submit-signed|submit|reconcile)$/);
  if (method === "POST" && fundingLegMatch) {
    return businessId ? { kind: "business", businessId } : { kind: "invalid" };
  }

  const walletMatch = pathname.match(/^\/v1\/admin\/wallets\/([a-zA-Z0-9_-]+)\/disable$/);
  if (method === "POST" && walletMatch) {
    return { kind: "business", businessId, resource: { table: "wallets", id: walletMatch[1] } };
  }

  if (method === "POST" && pathname === "/v1/admin/balances" && typeof body?.walletId === "string") {
    return { kind: "business", businessId, resource: { table: "wallets", id: body.walletId } };
  }

  if (method === "POST" && pathname === "/v1/admin/x402/reconcile" && typeof body?.reservationId === "string") {
    return { kind: "business", businessId, resource: { table: "x402_payment_reservations", id: body.reservationId } };
  }

  return { kind: "invalid" };
}

export function isDashboardRoleAllowed(role: string | null | undefined, method: string): boolean {
  if (method === "GET" || method === "HEAD") return ["owner", "admin", "analyst"].includes(role ?? "");
  return role === "owner" || role === "admin";
}

export function matchesBusinessScope(
  sessionBusinessId: string | null | undefined,
  targetBusinessId: string | null | undefined
): boolean {
  return Boolean(sessionBusinessId && targetBusinessId && sessionBusinessId === targetBusinessId);
}


/**
 * Validate browser origins for admin writes. The Pages frontend proxies /v1
 * requests to the API Worker, so the browser Origin is the Pages origin while
 * the Worker request URL has the workers.dev origin. Only explicitly
 * configured frontend origins may cross that boundary.
 */
export function isAllowedAdminOrigin(
  origin: string | null,
  requestOrigin: string,
  configuredOrigins = ""
): boolean {
  if (!origin) return false;
  const allowed = [requestOrigin, ...configuredOrigins.split(",")]
    .map((value) => value.trim())
    .filter(Boolean);
  try {
    const suppliedOrigin = new URL(origin).origin;
    return allowed.some((candidate) => {
      try {
        return new URL(candidate).origin === suppliedOrigin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
