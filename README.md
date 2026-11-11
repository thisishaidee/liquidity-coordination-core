# Liquidity Coordination Core

API-first infrastructure for coordinating authorized liquidity across AI agents.

**Current milestone:** decision-only V1 core on Cloudflare Workers + D1, initially Solana and six-decimal USDC accounting.

## Implemented in this scaffold

- Exact decimal-to-atom conversion using BigInt.
- Liquidity decisions: direct fulfillment, conversion required, or insufficient authorized funds.
- Worker routes: GET /health, POST /v1/liquidity/requests, GET /v1/operations/:id.
- Bearer API-key authentication against SHA-256 hashes stored in D1.
- Agent/business wallet-scope checks.
- Duplicate task guard using unique (agent_id, task_id).
- D1 schema for businesses, agents, wallets, balance snapshots and operations.
- Unit tests for precision, authorization and decision branches.

## Important limitations

This is not a production funds executor.

- The request endpoint reads balance snapshots and records a decision. It does not yet reserve funds atomically.
- It does not execute transfers, sign transactions, or call Swap.io yet.
- Balance snapshots must come from a trusted indexing/balance source, never from an agent request.
- API-key issuance/rotation and business onboarding are not yet implemented.
- The Wrangler D1 database ID is a placeholder.

Never place wallet private keys in this service. Signing must remain in a separate business-controlled signer.

## Local setup

```bash
npm install
npm test
npm run typecheck
```

Create a Cloudflare D1 database, set its ID in wrangler.toml, then apply the migration:

```bash
npx wrangler d1 create liquidity-coordination
npx wrangler d1 migrations apply liquidity-coordination --local
```

## Example request

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

A direct-fulfillment decision means sufficient authorized target-token liquidity was observed. It does not mean funds have been reserved or transferred.

## Next milestone

1. Atomic reservations and release/expiry handling.
2. Secure agent provisioning and key rotation.
3. Trusted balance observation adapter.
4. Swap.io x402 quote/build integration.
5. Separate signer/approval interface and on-chain settlement verification.
