# NERITH controlled devnet testing

**Purpose:** isolate local devnet testing from the production Worker and production D1 database.

## Safety boundary

- Use `wrangler.devnet.toml` only with `wrangler dev --local` and D1 commands with `--local`.
- The config uses a distinct Worker name and a placeholder D1 ID. It is not a Cloudflare staging deployment configuration.
- Never run `wrangler deploy`, `wrangler d1 migrations apply --remote`, or a command without `--local` using this file.
- Do not copy production D1 identifiers, production secrets, production wallet keys, or treasury credentials into this environment.
- Use a dedicated low-balance test wallet and Solana devnet only. Never use a primary treasury wallet.
- Keep `.dev.vars` local and untracked. Do not paste secrets or seed phrases into chat, issues, logs or screenshots.

## Prepare the local database

From the repository root:

```sh
npm ci
npm run build:dashboard
npx wrangler d1 migrations apply DB --local --config wrangler.devnet.toml --persist-to .wrangler/state/nerith-devnet
```

The local database is persisted under a separate directory so it cannot silently reuse the default local D1 state.

## Start the local Worker

```sh
npx wrangler dev --local --config wrangler.devnet.toml --persist-to .wrangler/state/nerith-devnet
```

Provide only devnet RPC configuration and disposable test credentials through the ignored local `.dev.vars` file, following the variable names actually required by the Worker. Do not add production values.

## Test order

1. Health check and database migration status.
2. Create a disposable business and admin session in local D1.
3. Register and prove ownership of a devnet test wallet.
4. Verify wallet role assignment and owner/admin authorization.
5. Prepare a small USDC funding leg.
6. Sign with one wallet, then test two distinct signers.
7. Submit the exact signed payload and verify the Worker-side checks.
8. Confirm finalized transaction status and actual fee reconciliation.
9. Confirm reserve replenishment finalizes before final-payment preparation.
10. Exercise rejection, disconnect, stale blockhash, duplicate submission, RPC timeout and replay cases.

## Mobile-wallet limitation

A local Worker is not automatically reachable from a separate Android device. Real Android wallet handoff requires a deliberately configured, isolated remote test endpoint and isolated remote D1 database. Do not expose the local Worker publicly or point a test UI at production. Create that remote test environment as a separate reviewed setup step.

## Evidence classification

- Unit tests and local D1 integration are automated evidence.
- A wallet connection is not proof of signing.
- A successful broadcast is not proof of settlement.
- Only a finalized on-chain transaction independently reconciled by the Worker counts as a completed funding leg.
- Hermes HTTP 402 challenge capture is unpaid evidence, not a successful paid x402 transaction.
