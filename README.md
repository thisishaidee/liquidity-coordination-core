# Liquidity Coordination Core

API-first infrastructure for coordinating authorized liquidity across AI agents.

**Current milestone:** Cloudflare Workers + D1, initially Solana and six-decimal USDC accounting.

## Current API

| Method | Route | Purpose |
|---|---|---|
| GET | `/` | Read-only browser dashboard |
| GET | `/health` | Service health |
| POST | `/v1/admin/bootstrap` | Create a business and its first agent |
| POST | `/v1/admin/agents` | Provision an additional scoped agent |
| GET | `/v1/admin/agents?businessId=...` | List agents without exposing their keys |
| POST | `/v1/admin/wallets` | Register an authorized Solana wallet |
| POST | `/v1/admin/balances` | Record a controlled manual balance snapshot |
| POST | `/v1/admin/balances/sync` | Refresh registered wallet balances from Solana RPC |
| POST | `/v1/admin/reservations/expire` | Manually sweep expired reservations |
| POST | `/v1/admin/telegram/link-codes` | Create a one-time private Telegram linking invitation |
| POST | `/v1/telegram/webhook` | Receive verified Telegram bot updates |
| POST | `/v1/liquidity/requests` | Submit a task funding request |
| GET | `/v1/liquidity` | Read authorized operating-wallet balances |
| GET | `/v1/operations` | List the authenticated agent's recent operations |
| POST | `/v1/conversions/quote` | Request a paid Swap.io quote through x402 |
| POST | `/v1/conversions/prepare` | Build an unsigned Swap.io transaction through x402 |
| POST | `/v1/conversions/track` | Record the transaction signature after wallet broadcast |
| GET | `/v1/conversions/status/:operationId` | Poll and verify conversion settlement |
| GET | `/v1/operations/:id` | Read an agent's operation |
| POST | `/v1/operations/:id/release` | Release an active internal reservation |

Admin routes require `ADMIN_BOOTSTRAP_TOKEN` as a Bearer token. Agent routes require an agent API key.

## Implemented

- Exact decimal-to-atom conversion using BigInt.
- Conservative liquidity decision engine.
- Direct USDC liquidity reservation from one eligible wallet.
- Conditional balance update to prevent concurrent over-reservation.
- Reservation expiry timestamp (15 minutes) and explicit release endpoint.
- Agent and business wallet scope enforcement.
- Business/agent provisioning with one-time API key return; only SHA-256 key hashes are stored.
- Duplicate task guard using unique (agent_id, task_id).
- D1 schema and migrations for businesses, agents, wallets, balances, operations and reservations.
- GitHub Actions CI for typecheck and tests.

## Important safety boundaries

This is still an early backend, not a production funds executor.

- Reservations are internal ledger holds. They do not transfer or spend funds.
- V1 only fulfills directly from one eligible USDC wallet. It deliberately does not combine multiple wallets until split reservations can be made atomically.
- Swap.io quote and unsigned transaction preparation are proxied through x402. The caller's x402 client signs the separate USDC API payment; this Worker never receives wallet private keys. The caller must still sign the returned swap transaction locally.
- The manual admin balance endpoint accepts operator-entered snapshots for controlled testing only. The admin sync endpoint reads SOL and USDC balances from Solana RPC at confirmed commitment. Never accept balances from agent requests.
- A scheduled Worker runs reservation expiry cleanup every minute. The admin expiry endpoint is also available for manual reconciliation. Verify the cron trigger is active after deployment.
- API-key rotation, user login, business-level dashboard authorization and rate limiting remain future work.
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

Create a Cloudflare D1 database, set its ID in `wrangler.toml`, then apply migrations:

```bash
npx wrangler d1 create liquidity-coordination
npx wrangler d1 migrations apply liquidity-coordination --local
```

For a remote database, apply migrations with `--remote`. Do not deploy until the production database binding and secret are configured.

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
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "biz_...",
    "agentName": "research-agent",
    "canUseBusinessTreasury": false
  }'
```

List agents with `GET /v1/admin/agents?businessId=biz_...`. The response never includes API keys.

## Register a wallet

```bash
curl -X POST http://localhost:8787/v1/admin/wallets \
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
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
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
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
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
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
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN"
```

Snapshots older than five minutes are excluded from liquidity decisions.

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

- `POST /v1/conversions/quote` accepts `operationId`, registered `userAddress`, `sourceAmount` in SOL and optional `slippageBps`.
- The API verifies the operation belongs to the authenticated agent, the wallet is authorized, and the SOL balance snapshot is fresh and sufficient.
- The request is translated to the Hermes quote schema using wrapped SOL as the input mint and canonical Solana USDC as the output mint.
- The upstream HTTP 402 body and payment headers are relayed. An x402-compatible client handles the separate USDC API payment and retries with `X-PAYMENT`; the Worker forwards that proof to Hermes.
- `POST /v1/conversions/prepare` accepts `operationId`, `userAddress`, `sourceAmount`, `provider` and the selected quote's `providerQuote`. It returns the unsigned base64 transaction from Hermes.

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
```

The x402 client wallet must match the registered `api_payment` wallet and needs a fresh balance of at least 0.01 USDC for quote and build calls. Before preparing a transaction, compare the quote's minimum output with the `X-Liquidity-Required-USDC` response header; do not build a quote that cannot cover the task shortfall. That reserve is distinct from the operating wallet's SOL being converted. The build endpoint reserves the requested SOL amount before preparing the unsigned transaction. After the business-controlled signer broadcasts it, call `POST /v1/conversions/track` with the operation ID and Solana signature, then poll `GET /v1/conversions/status/:operationId`. The status handler checks Hermes status and independently verifies the finalized Solana transaction: the registered wallet must have spent the reserved SOL and received USDC. It marks the wallet snapshots stale after terminal settlement so they must be refreshed before further liquidity decisions. No paid API request has been made by this repository's implementation.

## Browser dashboard

The Worker serves a responsive read-only dashboard at `/`. Connect with an agent API key to inspect authorized operating-wallet balances and the agent's latest 50 operations. The key is held in page memory only and is not written to local or session storage. The dashboard cannot sign transactions, move funds, or change permissions.

## Telegram business alerts

Telegram is an optional notification surface; the API remains the source of truth. V1 supports private-chat linking and notifications for liquidity shortfalls, reservations, releases, expiries and conversion settlement. It does not approve or sign transactions in Telegram.

Configure the bot secrets:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_BOT_USERNAME
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

Set the Telegram webhook to the deployed Worker URL:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://YOUR_WORKER/v1/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

Create a one-time invitation for a business:

```bash
curl -X POST https://YOUR_WORKER/v1/admin/telegram/link-codes \
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"businessId":"biz_..."}'
```

Send the returned deep link privately to the authorized business user. The link expires in 15 minutes and can only be used once. Group chats are not accepted. Telegram delivery is best-effort and cannot roll back or authorize a financial operation.

## Next milestones

1. Business-level authentication, scoped admin roles and agent key rotation.
2. Approval policies and isolated wallet signer integration.
3. Multi-wallet split reservations and direct task-completion reconciliation.
4. Quote schema validation and automated minimum-output selection.
5. More robust monitoring, rate limits and integration tests.
