# Liquidity Coordination Core

API-first infrastructure for coordinating authorized liquidity across AI agents.

**Current milestone:** Cloudflare Workers + D1, initially Solana and six-decimal USDC accounting.

## Current API

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Service health |
| POST | `/v1/admin/bootstrap` | Create a business and its first agent |
| POST | `/v1/admin/wallets` | Register an authorized Solana wallet |
| POST | `/v1/admin/balances` | Record a controlled manual balance snapshot |
| POST | `/v1/admin/balances/sync` | Refresh registered wallet balances from Solana RPC |
| POST | `/v1/admin/reservations/expire` | Manually sweep expired reservations |
| POST | `/v1/liquidity/requests` | Submit a task funding request |
| POST | `/v1/conversions/quote` | Request a paid Swap.io quote through x402 |
| POST | `/v1/conversions/prepare` | Build an unsigned Swap.io transaction through x402 |
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

## Register a wallet

```bash
curl -X POST http://localhost:8787/v1/admin/wallets \
  -H "Authorization: Bearer YOUR_ADMIN_BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "biz_...",
    "scope": "agent",
    "agentId": "agt_...",
    "network": "solana",
    "address": "SOLANA_PUBLIC_ADDRESS"
  }'
```

Business-scope wallets omit `agentId`. An agent can use a business wallet only when `canUseBusinessTreasury` was explicitly enabled at provisioning.

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
  wallet: {
    address: businessWallet.publicKey.toString(),
    signTransaction: async (tx) => {
      tx.sign([businessWallet]);
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
    userAddress: businessWallet.publicKey.toString(),
    sourceAmount: "0.1",
    slippageBps: 50
  })
});
```

The wallet used by the x402 client needs a separate USDC reserve for Hermes API charges. That is distinct from SOL being converted. The returned swap transaction is unsigned; signing and broadcasting remain outside this Worker. No paid API request has been made by this repository's implementation.

## Next milestones

1. Trusted on-chain balance observer for Solana.
2. Reservation expiry worker and reconciliation.
3. Swap.io x402 quote/build integration with explicit API-payment reserve.
4. Approval policy and isolated signer integration.
5. Telegram notifications and secure approval actions.
6. Business dashboard and audit history.
