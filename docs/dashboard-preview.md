# NERITH business dashboard preview

## Route and access

The preview is served at `/dashboard`. It is an operator-managed preview, not customer authentication.

1. Open `/control` and establish the existing operator session using the current Business Setup flow.
2. Open `/dashboard` and enter the business ID.
3. The dashboard calls the existing `/v1/admin/*` routes with same-origin credentials. The browser never stores or asks for an API token on this page.

The existing `nerith_admin_session` cookie remains HttpOnly, Secure, SameSite=Strict, scoped to `/v1/admin`, and retains its current expiry. The preview does not add a second cookie, auth endpoint, role model or session mechanism. Existing operator sessions can access business IDs across the account; this is not suitable as customer membership authentication.

Customer sign-in, business membership, per-business authorization, roles and audit history remain a separate future milestone.

## Page-to-endpoint map

| Page | Data source |
|---|---|
| Overview | `GET /v1/admin/workspace`, `/agents`, `/wallets`, `/forecast`, `/operations` |
| Agents | `GET /v1/admin/agents` |
| Liquidity | `GET /v1/admin/wallets` |
| Forecasts | `GET /v1/admin/forecast` |
| Operations | `GET /v1/admin/operations` |
| Telegram | `GET /v1/admin/telegram/connections` |
| Settings | `GET /v1/admin/workspace` |

No dashboard API key, agent API key or secret is requested by the page.

## New read-only endpoints

### `GET /v1/admin/operations?businessId=&limit=&cursor=&status=`

- Uses the existing `isAdmin()` authorization path.
- Requires a business ID and verifies that the business exists.
- All row and status-count queries are scoped by `operations.business_id`.
- Default page size is 50; maximum is 100.
- Uses a keyset cursor based on `created_at` and `id`.
- Optional status filter accepts known operation states. Unknown states remain visible in unfiltered history and status counts.
- Approval, execution and settlement are separate response objects.
- Pending approval is shown only for a reserved direct-fulfillment operation with an active, unexpired reservation and no recorded decision.
- The transaction hash is shown as execution evidence; it does not itself imply settlement.
- `completed` remains agent-reported and is not represented as verified external payment.
- Empty history returns HTTP 200 with an empty array and empty status counts.
- Errors return a generic `internal_error`; database details are not exposed.

### `GET /v1/admin/forecast?businessId=`

- Uses the existing `isAdmin()` authorization path and verifies the requested business.
- Reuses the same business-wide wallet allocation logic as the agent-key forecast.
- Reads planned obligations for active agents due within 30 days, ordered by due date, with the existing 200-row cap.
- Includes only active Solana wallets with purpose `operating`; `api_payment` wallets are excluded.
- Business wallets are eligible only for agents with explicit business-treasury permission. Agent wallets remain isolated to their owner.
- Freshness uses the existing five-minute balance window. Stale balances are treated as zero available and can overstate shortfalls.
- Conversion-required means a possible eligible SOL source exists; it is not a quote and has no verified fees, slippage, price impact or route availability.
- No confidence score is calculated; the UI explicitly says it is unavailable.
- Empty businesses return HTTP 200 with empty obligations and zero summary.
- `truncated` is true when the 200-obligation cap is reached.

## Data boundaries and unavailable items

- Operating liquidity is aggregated only from `purpose=operating` wallets and fresh snapshots. Reserved funds are deducted from availability.
- x402 `purpose=api_payment` balances are shown separately and never included in operating totals or forecasts.
- Balance amounts retain their observed timestamp and freshness state.
- Agent last activity, per-agent operation counts, team-member roles, Telegram recent activity, forecast confidence, notification preferences and security settings are not exposed by the current API. The UI labels them unavailable instead of fabricating values.
- The dashboard does not sign, broadcast or transfer transactions.
- It does not add controls for operations that have no existing supported endpoint.
- Support, Privacy and Terms destinations are not published and are not invented as links.

## Implementation constraints

- No schema changes or migrations.
- No new secrets, auth cookies, customer login, or auth bypass.
- No writes from dashboard pages.
- Existing agent-key `/v1/liquidity/forecast` and `/v1/operations` behaviour must remain unchanged.
- `/dashboard` uses the same restrictive page Content Security Policy as the existing browser pages.
- Dashboard HTML is source-controlled in `public/dashboard.html` and embedded into `src/business-dashboard.ts` by `scripts/embed-business-dashboard.mjs`.
- `npm run build:dashboard` regenerates all browser page modules.
