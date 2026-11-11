# Liquidity Coordination Core

API-first infrastructure for coordinating authorized liquidity across AI agents.

**Current milestone:** Cloudflare Workers + D1, initially Solana and six-decimal USDC accounting.

## Current API

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Service health |
| POST | `/v1/admin/bootstrap` | Create a business and its first agent |
| POST | `/v1/admin/wallets` | Register an authorized Solana wallet |
| POST | `/v1/liquidity/requests` | Submit a task funding request |
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
- Alternative-token detection is a decision only. Swap.io quote/build/submit is not connected yet.
- Wallet balance snapshots must be populated by a trusted balance observer/indexer. Do not accept balances from agent requests.
- Expired reservations are not yet automatically swept. Until a scheduled expiry worker is added, use the release endpoint or administrative reconciliation.
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

## Next milestones

1. Trusted on-chain balance observer for Solana.
2. Reservation expiry worker and reconciliation.
3. Swap.io x402 quote/build integration with explicit API-payment reserve.
4. Approval policy and isolated signer integration.
5. Telegram notifications and secure approval actions.
6. Business dashboard and audit history.
