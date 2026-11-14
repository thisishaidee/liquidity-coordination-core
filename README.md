# NERITH

**Liquidity coordination for autonomous agents.**

![NERITH primary logo](assets/nerith-lockup.svg)

The primary identity uses the flowing three-path convergence mark. The standalone symbol is available at [assets/nerith-mark.svg](assets/nerith-mark.svg); the full symbol-and-wordmark lockup is [assets/nerith-lockup.svg](assets/nerith-lockup.svg).

NERITH is an API-first infrastructure layer that anticipates agent funding needs, coordinates authorized liquidity across business wallets, and prepares asset conversions when a task requires them. It helps autonomous systems get the right assets in the right place before work is blocked.

**Current milestone:** Cloudflare Workers + D1, initially Solana and six-decimal USDC accounting.

NERITH keeps business custody in the business's hands. Agents use scoped API credentials; wallet signing remains with the business-controlled signer. The platform coordinates liquidity and prepares transactions, but does not hold private keys or autonomously move funds.

## Product and security documentation

- [Product and architecture overview](docs/PRODUCT_OVERVIEW.md)
- [Autonomous multi-wallet liquidity architecture](docs/AUTONOMOUS_LIQUIDITY_ARCHITECTURE.md) (implementation specification; not yet live)
- [Static security audit (12 November 2026)](docs/SECURITY_AUDIT_2026-11-12.md)
- [Cross-platform wallet handoff requirements](docs/WALLET_HANDOFF_CROSS_PLATFORM.md) (target architecture; not yet implemented or device-verified)

## Current API

| Method | Route | Purpose |
|---|---|---|
| GET | `/` | Public NERITH landing page |
| GET | `/app` | Read-only agent-scoped browser console |
| GET | `/dashboard` | Operator-managed business dashboard preview |
| GET | `/health` | Service health |
| POST | `/v1/admin/bootstrap` | Platform-token-only creation of a business and its first agent |
| POST | `/v1/admin/session` | Establish a 12-hour session bound to one existing business |
| POST | `/v1/admin/agents` | Provision an additional scoped agent |
| GET | `/v1/admin/agents?businessId=...` | List agents without exposing their keys |
| GET | `/v1/admin/operations?businessId=...` | Business-scoped operation history with approval, execution and settlement states |
| GET | `/v1/admin/forecast?businessId=...` | Business-wide 30-day obligation forecast across active agents and operating wallets |
| POST | `/v1/admin/agents/:id/rotate-key` | Rotate an agent API key immediately |
| POST | `/v1/admin/agents/:id/disable` | Disable an agent credential |
| POST | `/v1/admin/wallets/:id/disable` | Revoke a wallet after its active reservations clear |
| POST | `/v1/admin/wallets` | Register an authorized Solana wallet |
| GET | `/v1/admin/wallet-roles?businessId=...` | List business-scoped wallet roles |
| POST | `/v1/admin/wallet-roles` | Assign or update a business wallet role and its reserve limits |
| POST | `/v1/admin/wallet-ownership/challenge` | Create a five-minute wallet ownership message challenge |
| POST | `/v1/admin/wallet-ownership/verify` | Verify a wallet-signed ownership challenge |
| POST | `/v1/admin/balances` | Record a controlled manual balance snapshot |
| POST | `/v1/admin/balances/sync` | Refresh registered wallet balances from Solana RPC |
| GET | `/v1/admin/payment-policy?businessId=...` | Read business payment policy |
| POST | `/v1/admin/payment-policy` | Update business payment policy |
| POST | `/v1/payments/prepare` | Agent-authenticated, idempotent payment-intent preparation and guarded funding reservations |
| POST | `/v1/admin/payment-intents/:intentId/funding-legs/:legId/submit?businessId=...` | Record a business-owner-signed transaction signature |
| POST | `/v1/admin/payment-intents/:intentId/funding-legs/:legId/reconcile?businessId=...` | Verify finalized SPL-token settlement from Solana RPC |
| POST | `/v1/admin/payment-intents/:intentId/prepare-final-payment?businessId=...` | Refresh finalized payment-wallet USDC and reserve final payment after all replenishment legs confirm |
| POST | `/v1/admin/reservations/expire` | Platform-token-only manual sweep of expired reservations |
| POST | `/v1/admin/telegram/setup` | Platform-token-only shared bot setup, webhook registration and command publishing |
| GET | `/v1/admin/telegram/status` | Platform-token-only shared Telegram webhook status |
| GET/POST | `/v1/admin/x402/budgets` | Read or set business-wide and per-agent daily x402 USDC spending limits |
| POST | `/v1/admin/x402/reconcile` | Reconcile a pending x402 reservation with its finalized on-chain receipt |
| POST | `/v1/admin/telegram/link-codes` | Create a one-time private Telegram linking invitation |
| POST | `/v1/telegram/webhook` | Receive verified Telegram bot updates |
| POST | `/v1/liquidity/requests` | Submit a task funding request |
| GET | `/v1/liquidity` | Read authorized operating-wallet balances |
| POST | `/v1/liquidity/forecast` | Publish up to 50 upcoming USDC obligations |
| GET | `/v1/liquidity/forecast` | Project 30-day wallet-level liquidity coverage |
| POST | `/v1/liquidity/forecast/:taskId/fulfilled` | Close a planned obligation as fulfilled |
| POST | `/v1/liquidity/forecast/:taskId/cancelled` | Cancel a planned obligation |
| GET | `/v1/operations` | List the authenticated agent's recent operations |
| POST | `/v1/conversions/quote` | Request a paid Swap.io quote through x402 |
| POST | `/v1/conversions/prepare` | Build an unsigned Swap.io transaction through x402 |
| POST | `/v1/conversions/track` | Record the transaction signature after wallet broadcast |
| GET | `/v1/conversions/status/:operationId` | Free Solana RPC status polling and settlement verification |
| GET | `/v1/operations/:id` | Read an agent's operation |
| POST | `/v1/operations/:id/release` | Release an active internal reservation |
| POST | `/v1/operations/:id/complete` | Consume reservations after the agent reports task completion |

`ADMIN_BOOTSTRAP_TOKEN` is a platform-wide root credential, not a business password. It is accepted only for workspace bootstrap, session establishment, shared Telegram bot setup/status and the manual reservation-expiry route. To establish a business session, send `POST /v1/admin/session` with the platform token and JSON body `{ "businessId": "biz_..." }`. The Worker verifies the business and sets an HttpOnly, Secure, SameSite=Strict cookie that expires after 12 hours. All ordinary admin workspace routes require that cookie and must match its business ID. Agent, wallet, manual balance and x402 reservation actions resolve the resource's owning business from D1 before authorization. The bootstrap token alone cannot access a business workspace. Migration `0023_admin_session_business_scope.sql` invalidates old unscoped sessions. Agent routes require an agent API key.

## Implemented

- Exact decimal-to-atom conversion using BigInt.
- Conservative liquidity decision engine.
- Direct USDC liquidity reservation from one eligible wallet in the existing V1 agent flow.
- Business payment-intent preparation with deterministic policy evaluation, business-wide idempotency, daily and per-transaction caps, and atomic multi-wallet USDC/SOL reservation holds.
- Owner/admin-only funding-leg submission and finalized Solana RPC reconciliation with exact SPL transfer verification, immutable transaction signatures, ambiguity holds and separate network-fee validation.
- Finalized payment-wallet USDC refresh after all reserve legs confirm; the final-payment leg and reservation are unlocked atomically under database-enforced intent and funding-leg gates.
- Finalized SPL-token balance lookup validates owner, mint, decimals and canonical atom amounts across every token account.
- Conditional balance update to prevent concurrent over-reservation.
- Reservation expiry timestamp (15 minutes) and explicit release endpoint.
- Agent and business wallet scope enforcement.
- Business/agent provisioning with one-time API key return; only SHA-256 key hashes are stored.
- Duplicate task guard using unique (agent_id, task_id).
- D1 schema and migrations for businesses, agents, wallets, balances, operations and reservations.
- GitHub Actions CI for typecheck and tests.


## x402 API payment budgets

NERITH applies daily USDC spending limits to paid Hermes quote and build calls. Defaults are **0.01 USDC per agent per UTC day** and **0.05 USDC per business per UTC day**. Each payment consumes both the agent allowance and the shared business allowance. Pending, ambiguous payments continue to count against the budget until reconciled.

Read the current limits and today's usage:

```http
GET /v1/admin/x402/budgets?businessId=biz_...
```

Set a business-wide limit or an individual agent limit (zero disables paid calls at that scope):

```json
{
  "businessId": "biz_...",
  "agentId": "agt_...",
  "dailyLimitUSDC": "0.02"
}
```

Send that body to `POST /v1/admin/x402/budgets` using an authenticated admin session. Omit `agentId` to change the business-wide cap.

The Worker stores the actual Hermes V1 Solana challenge for the exact operation/request, reserves its quoted amount before forwarding the payment, rejects payment replay, and verifies the finalized receipt transaction against the challenge's USDC mint, exact payer debit, exact recipient credit, payer signature and advertised facilitator fee payer before marking spend as settled. A timeout, missing receipt or RPC uncertainty keeps the reservation pending instead of silently freeing budget. GET budgets also lists pending reservations; after a receipt transaction is available, an authenticated admin can POST `{ "reservationId": "x4r_..." }` to `/v1/admin/x402/reconcile` to retry verification. These limits govern paid calls routed through NERITH; they are not a wallet-level spending lock for direct transfers made outside NERITH.

## Deterministic payment policy

The draft includes a pure evaluator in `src/transaction-policy.ts`. It checks business scope, idempotency, intent expiry, asset and destination allowlists, per-transaction and daily limits, fresh verified payment/reserve wallets, reserve floors, transfer caps, SOL network-fee payer allowlists and balances, and conversion-source/slippage policy. It can return a direct-payment, reserve-replenishment, conversion-required or explicitly permitted partial-payment plan.

The evaluator is planning and policy logic only. The payment-preparation API now persists intents, funding legs and bounded internal reservations; owner/admin settlement routes accept externally signed transaction signatures and verify finalized on-chain transfers. NERITH still does not build, sign or broadcast these transfers. Replenishment can unlock a final-payment reservation only after a separate finalized balance refresh. Conversion remains out of scope for this funding-leg verifier.

## Important safety boundaries

This is still an early backend, not a production funds executor.

- Reservations are internal ledger holds. They do not transfer or spend funds.
- V1 only fulfills directly from one eligible USDC wallet. It deliberately does not combine multiple wallets until split reservations can be made atomically.
- Swap.io quote and unsigned transaction preparation are proxied through x402. The caller's x402 client signs the separate USDC API payment; this Worker never receives wallet private keys. The caller must still sign the returned swap transaction locally.
- The manual admin balance endpoint accepts operator-entered snapshots for controlled testing only. The admin sync endpoint reads SOL and USDC balances from Solana RPC at confirmed commitment. Never accept balances from agent requests.
- A scheduled Worker runs reservation expiry cleanup every minute. The admin expiry endpoint is also available for manual reconciliation. Verify the cron trigger is active after deployment.
- Agent API-key rotation is implemented. Sensitive agent routes have persistent rate limits; user login, business-member authorization and broader route-specific abuse controls remain future work.
- No wallet private keys or signing secrets belong in this Worker.

The admin bootstrap token must be configured as a Cloudflare secret:

```bash
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
```

Use a long, random secret and never commit it.

## Local setup

```bash
npm install
npm run typecheck
npm test
```

Use the dedicated Cloudflare D1 database already provisioned for this repository. Its ID is configured in `wrangler.toml`; migrations 0001 through 0032 are tracked in `migrations/`; apply all pending migrations and verify them in `d1_migrations`. For a fresh environment, create a D1 database and apply migrations:

```bash
npx wrangler d1 create liquidity-coordination
npx wrangler d1 migrations apply liquidity-coordination --local
# For the provisioned production database:
npx wrangler d1 migrations apply liquidity-coordination --remote
```

For a remote database, apply migrations with `--remote`. Do not deploy until the Worker secret is configured. The database binding is already set up.

## Establish a business-scoped admin session

After creating a business, or when reconnecting to an existing one, establish a browser or CLI session for that exact business. The legacy global admin sessions are invalidated by migration 0023.

```bash
curl -c admin.cookies -X POST http://localhost:8787/v1/admin/session \
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
  -H "Origin: http://localhost:8787" \
  -H "Content-Type: application/json" \
  -d '{"businessId":"biz_..."}'
```

Use `-b admin.cookies` and the same-origin `Origin` header for subsequent POST requests to business-scoped admin routes. Do not send the platform token to those routes. Shared Telegram bot setup/status and manual reservation expiry remain platform-wide and require the platform token.

## Provision a business and first agent

```bash
curl -X POST http://localhost:8787/v1/admin/bootstrap \
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessName": "Example Business",
    "agentName": "payments-agent",
    "canUseBusinessTreasury": false
  }'
```

The response contains an agent API key once. Store it securely; the service stores only its hash.

## Provision additional agents

Use the admin endpoint to add more agents to an existing business. Each agent gets an independent API key and an explicit business-treasury permission.

```bash
curl -X POST http://localhost:8787/v1/admin/agents \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "biz_...",
    "agentName": "research-agent",
    "canUseBusinessTreasury": false
  }'
```

List agents with `GET /v1/admin/agents?businessId=biz_...`. The response never includes API keys.

### Rotate or disable an agent

```bash
curl -X POST http://localhost:8787/v1/admin/agents/agt_.../rotate-key \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies

curl -X POST http://localhost:8787/v1/admin/agents/agt_.../disable \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies
```

Rotation invalidates the old key immediately and returns the replacement once. Disabling an agent prevents future authenticated requests.

### Revoke a wallet

```bash
curl -X POST http://localhost:8787/v1/admin/wallets/wal_.../disable \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies
```

Wallet revocation is refused while active internal reservations reference that wallet.

## Register a wallet

```bash
curl -X POST http://localhost:8787/v1/admin/wallets \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "biz_...",
    "scope": "agent",
    "purpose": "operating",
    "agentId": "agt_...",
    "network": "solana",
    "address": "SOLANA_PUBLIC_ADDRESS"
  }'
```

Business-scope wallets omit `agentId`. An agent can use a business operating wallet only when `canUseBusinessTreasury` was explicitly enabled at provisioning. Register a separate business-scope wallet with `"purpose": "api_payment"` for the x402 USDC payment reserve; API-payment wallets are excluded from operating liquidity calculations.

### Register the dedicated x402 payment wallet

Use a separate business wallet for API fees. Do not register this wallet as an operating wallet.

```bash
curl -X POST http://localhost:8787/v1/admin/wallets \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "biz_...",
    "scope": "business",
    "purpose": "api_payment",
    "network": "solana",
    "address": "X402_PAYMENT_WALLET_ADDRESS"
  }'
```

After funding it with USDC, sync balances. Conversion quote/build requests require this dedicated wallet to have a fresh balance of at least 0.01 USDC.

## Record a test balance snapshot

This admin-only endpoint is for controlled development/testing. It does not verify the wallet's on-chain balance.

```bash
curl -X POST http://localhost:8787/v1/admin/balances \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies \
  -H "Content-Type: application/json" \
  -d '{
    "walletId": "wal_...",
    "token": "USDC",
    "amount": "25"
  }'
```

USDC snapshots use six decimals; SOL snapshots use nine decimals. Snapshots older than five minutes are excluded from liquidity decisions.

## Sync registered wallets from Solana

The sync endpoint reads native SOL and the canonical Solana USDC mint for every active registered wallet. It uses the public mainnet RPC by default; configure `SOLANA_RPC_URL` for a dedicated provider if needed.

```bash
curl -X POST http://localhost:8787/v1/admin/balances/sync \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies
```

Snapshots older than five minutes are excluded from liquidity decisions.

## Complete or release an operation

After the agent's downstream task has completed, it can call:

```bash
curl -X POST http://localhost:8787/v1/operations/OPERATION_ID/complete \
  -H "Authorization: Bearer YOUR_AGENT_API_KEY"
```

This consumes internal reservations and marks affected wallet snapshots stale so they must be refreshed from Solana before another liquidity decision. Completion is agent-reported; it is not proof that an external payment occurred. Use the `/release` endpoint when the task is cancelled or the reserved funds are no longer needed.

## Predictive liquidity forecast

Agents can publish expected USDC obligations up to 30 days ahead. The engine simulates due-date order against fresh, authorized wallet balances and reports which tasks appear covered, may need SOL conversion, or are blocked.

```bash
curl -X POST http://localhost:8787/v1/liquidity/forecast \
  -H "Authorization: Bearer YOUR_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "obligations": [
      {
        "taskId": "payout-tomorrow",
        "amount": "500",
        "dueAt": "2026-11-12T10:00:00Z",
        "purpose": "Contributor payouts"
      },
      {
        "taskId": "api-budget-friday",
        "amount": "40",
        "dueAt": "2026-11-13T14:00:00Z",
        "purpose": "Scheduled API usage"
      }
    ]
  }'
```

The forecast is advisory, not a reservation. It uses one-wallet allocation, does not pool assets across wallets, and marks a wallet as a potential conversion source at most once per forecast because the exact SOL needed is unknown until a live Swap.io quote is requested. Agents should update obligations when a task is fulfilled or cancelled.

## Submit a liquidity request

```bash
curl -X POST http://localhost:8787/v1/liquidity/requests \
  -H "Authorization: Bearer YOUR_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "payout-001",
    "network": "solana",
    "token": "USDC",
    "amount": "10",
    "purpose": "Contributor payout"
  }'
```

A `reserved` response means the amount is held in the internal ledger, not transferred. A `awaiting_conversion` response means an eligible alternative token was observed; it does not mean a swap has been quoted or executed.

## Swap.io x402 integration

The conversion endpoints proxy only to the fixed Hermes host; callers cannot supply arbitrary URLs.

- `POST /v1/conversions/quote` accepts `operationId`, registered operating `userAddress`, registered `paymentWalletAddress`, `sourceAmount` in SOL and optional `slippageBps`.
- The API verifies the operation belongs to the authenticated agent, the wallet is authorized, and the SOL balance snapshot is fresh and sufficient.
- The request is translated to the Hermes quote schema using wrapped SOL as the input mint and canonical Solana USDC as the output mint. Successful paid responses are accepted only when Hermes includes a successful `X-PAYMENT-RESPONSE` settlement receipt. Quotes are cached for 15 minutes.
- The upstream HTTP 402 body and payment headers are relayed. An x402-compatible client handles the separate USDC API payment and retries with `X-PAYMENT`; the Worker forwards that proof to Hermes.
- `POST /v1/conversions/prepare` accepts `operationId`, `paymentWalletAddress`, a server-issued `quoteId`, and optional quote `index`. The full provider quote stays cached in D1 and cannot be replaced by caller-supplied JSON. The API rejects any selected route whose minimum USDC output is below the operation's shortfall.

Example client shape (the signing wallet stays in the business-controlled agent runtime):

```js
import { createX402Client } from "x402-solana/client";

const client = createX402Client({
  // Separate USDC-funded wallet used only for x402 API payments.
  wallet: {
    address: apiPaymentWallet.publicKey.toString(),
    signTransaction: async (tx) => {
      tx.sign([apiPaymentWallet]);
      return tx;
    }
  },
  network: "solana"
});

const quoteResponse = await client.fetch("https://YOUR_API/v1/conversions/quote", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${AGENT_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    operationId: "op_...",
    userAddress: operatingWallet.publicKey.toString(),
    paymentWalletAddress: apiPaymentWallet.publicKey.toString(),
    sourceAmount: "0.1",
    slippageBps: 50
  })
});
const quote = await quoteResponse.json();

const buildResponse = await client.fetch("https://YOUR_API/v1/conversions/prepare", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${AGENT_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    operationId: "op_...",
    paymentWalletAddress: apiPaymentWallet.publicKey.toString(),
    quoteId: quote.quoteId,
    index: 0
  })
});
```

The x402 client wallet must match the registered `api_payment` wallet and needs a fresh balance of at least 0.01 USDC for quote and build calls. The API returns each route's minimum output and a `minOutputCoversShortfall` flag; it enforces the minimum output check again on the server before transaction building. That reserve is distinct from the operating wallet's SOL being converted. The build endpoint reserves the requested SOL amount before preparing the unsigned transaction. After the signature is tracked, active reservations are extended to a one-hour ceiling; if the transaction remains unconfirmed, the scheduled expiry worker releases the holds. After the business-controlled signer broadcasts it, call `POST /v1/conversions/track` with the operation ID and Solana signature, then poll `GET /v1/conversions/status/:operationId`. Status polling uses Solana RPC directly and does not incur another Hermes API charge. The status handler uses `getSignatureStatuses` and `getTransaction` from the configured Solana RPC, then independently verifies that the registered operating wallet signed the finalized transaction, received USDC, and had an exact SOL debit matching the reserved input plus evidenced fees and rent. It marks the wallet snapshots stale after terminal settlement so they must be refreshed before further liquidity decisions. No paid API request has been made by this repository's implementation.

## Browser dashboard

The Worker serves a public product landing page at `/`, a business-owner setup and Telegram linking page at `/control`, a read-only agent console at `/app`, and an operator-managed business dashboard preview at `/dashboard`. `npm run build:dashboard` regenerates the embedded HTML modules from `public/landing.html`, `public/index.html`, `public/control.html`, `public/dashboard.html` and `public/pixel-field.svg`. The business preview reuses the HttpOnly admin session cookie created through Business Setup; it does not introduce a second login, cookie or browser token store. Each session is bound to the selected business, and read-only endpoints cannot switch to another business by changing a query parameter. Resource-ID actions are checked against the owning business in D1. API-payment wallets are excluded from operating liquidity and forecasts. The preview does not sign transactions, move funds or imply individual customer identity or role-based membership is available yet. The shared platform token remains an operator-level root credential and must be kept private.

## Telegram business companion

Telegram is a private, business-scoped operations interface. A single linked Telegram identity receives business alerts, monitors liquidity, forecasts, agents and operations, creates liquidity requests, and reviews prepared requests. A newly linked Telegram identity receives the combined operator permission rather than requiring a separate requester and approver connection. The bot never signs transactions, moves funds or bypasses the business-controlled signer. NERITH's API and on-chain settlement remain the source of truth.

A user can create a request and review it from the same Telegram identity. Decisions on requests created by that same identity require Google Authenticator (TOTP) verification. Other authorized approvers continue to use the existing one-time approval buttons. Authenticator secrets are encrypted at rest with the Worker-only `TELEGRAM_TOTP_ENCRYPTION_KEY`; codes expire on the normal 30-second TOTP schedule, allow only a small clock-drift window, and each time-step can be used only once. The approval challenge expires after five minutes and is bound to the original operation snapshot. Authenticator verification records a business decision only; it does not sign or broadcast a transaction.

### Create and configure the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts to choose a display name and unique username.
2. Copy the bot token from BotFather. Keep it private.
3. In Cloudflare Worker secrets, set:
   - `TELEGRAM_BOT_TOKEN` — the token from BotFather.
   - `TELEGRAM_WEBHOOK_SECRET` — a private random string containing 32–64 hexadecimal characters.
4. Ensure `ADMIN_BOOTSTRAP_TOKEN` is configured as a Worker secret. The business admin API uses it to protect bot setup and linking invitations.
5. Set `TELEGRAM_TOTP_ENCRYPTION_KEY` as a Worker secret. Use a separate cryptographically random value of at least 32 characters. Do not reuse the bot token, webhook secret or admin bootstrap token. Keep this key stable; rotating it requires every linked Telegram operator to enroll Google Authenticator again.
6. Call the authenticated setup endpoint once. It validates the bot, registers the webhook and publishes Telegram's command menu:

```bash
curl -X POST https://YOUR_WORKER/v1/admin/telegram/setup \
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN"
```

The endpoint returns the bot username and configured webhook URL. The bot username is discovered through Telegram; it does not need to be stored as a separate secret.

### Link a business

Create a one-time invitation for the business:

```bash
curl -X POST https://YOUR_WORKER/v1/admin/telegram/link-codes \
  -H "Origin: http://localhost:8787" \
  -b admin.cookies \
  -H "Content-Type: application/json" \
  -d '{"businessId":"biz_..."}'
```

Open the returned `deepLink` from the one private Telegram account that should operate the business. Invitations expire after 15 minutes and can only be used once. Group chats are rejected. A new connection receives the combined operator permission.

### Bot commands

- `/status` — business overview, active agents, open operations and operating liquidity.
- `/liquidity` — confirmed, reserved and available operating balances, with snapshot freshness.
- `/forecast` — upcoming planned obligations.
- `/agents` — provisioned agents and their current status.
- `/operations` — latest liquidity operations and their states.
- `/setupauth` — generate a Google Authenticator setup key.
- `/verifyauth 123456` — verify and enable authenticator protection.
- `/confirmapproval 123456` — confirm a decision on a request created by this same Telegram identity.
- `/help` — command guide.
- `/disconnect` — revoke this chat's connection.

Telegram reports business-wide operating balances only to a chat linked through a business-admin-issued invitation. It excludes the separate x402 API-payment reserve from operating liquidity. Forecast entries are recorded plans, not proof that funds are available or reserved. Telegram delivery is best-effort and cannot roll back or authorize a financial operation.

## Next milestones

1. Individual admin identities and role-based permissions within each business.
2. Approval policies and isolated wallet signer integration.
3. Multi-wallet split reservations and direct task-completion reconciliation.
4. Quote schema validation and automated minimum-output selection.
5. More robust monitoring, broader rate-limit coverage and live integration tests.
