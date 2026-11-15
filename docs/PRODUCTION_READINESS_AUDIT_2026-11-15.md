# NERITH Phase 1 — Production Readiness Audit

**Date:** 15 November 2026  
**Base:** `main` at `a8307d4ba7742717b9d9893d1e66c8554f636501`  
**Scope:** Website, Cloudflare Worker/D1, Telegram, wallet integration, payment execution, transaction settlement, deployment configuration.  
**Type:** Read-only production and repository audit. No production data, secrets, wallet state, or deployments were changed.

## Executive result

NERITH's production Worker is reachable and its public health endpoint reports `status=ok`, `database=connected`, `telegramConfigured=true`, and `telegramSupportConfigured=true`. The public Telegram bot profile `@NerithLiquidityBot` resolves. The one-minute Worker cron is configured.

However, the newer business payment-intent and wallet-ownership implementation is **not in production**. It remains in draft PR #52. The multi-wallet role/planning foundation remains in open PR #51. PR #52's latest CI run passed typecheck, tests, Worker dry-run and isolated local Worker/D1 integration, but its production deploy job was skipped. No funded wallet round-trip, real device signing flow, finalized payment transaction, or paid x402 settlement has been demonstrated.

**Release posture:** production health is green, but production payment execution is not proven and must not be described as ready.

## 1. Repository and branch state

- Repository: `thisishaidee/nerith` (public), default branch `main`.
- Latest main commit at audit: `a8307d4`, 14 November 2026 07:06 UTC.
- PR #52, `feat/solana-wallet-ownership-proof`, is open and marked draft. It contains wallet ownership verification, payment intents, multi-wallet funding legs, signed transaction verification/broadcast, and finalized reconciliation. It is not merged or deployed.
- PR #51, `feat/autonomous-liquidity-foundation`, is open. It adds wallet roles and a deterministic multi-wallet liquidity planner. Its own safety boundary explicitly says the planner does not reserve, sign, broadcast, or move funds.
- PRs #53–55 are closed and not merged; they are validation branches, not production code.

## 2. Production Cloudflare state

### Worker

Cloudflare lists production Worker `liquidity-coordination-api` with:
- D1 binding to the configured `liquidity-coordination` database UUID.
- Secret bindings present by name: `ADMIN_BOOTSTRAP_TOKEN`, `SOLANA_RPC_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_TOTP_ENCRYPTION_KEY`, `TELEGRAM_WEBHOOK_SECRET`.
- Plain-text public URL and allowed-origin settings pointing at `https://neritth.pages.dev`.
- A configured cron schedule of `*/1 * * * *`.
- Latest recorded Worker deployment: 14 November 2026 07:07 UTC.

The production `/health` endpoint was fetched successfully and reported:
```json
{
  "service": "nerith-api",
  "status": "ok",
  "version": "0.3.0",
  "database": "connected",
  "dashboard": true,
  "telegramConfigured": true,
  "telegramSupportConfigured": true
}
```

This confirms configured secret bindings and runtime health, but it does not prove the Telegram webhook is currently registered or that a real command/notification round-trip succeeds. The authenticated Telegram status/setup endpoints require the platform bootstrap token, whose value is intentionally not exposed.

### Pages and live website

- Public site: `https://neritth.pages.dev`.
- Landing, `/dashboard`, `/app`, `/control`, and `/health` routes resolve.
- The Pages project's latest recorded deployment is 12 November 2026; the API Worker has a newer 14 November deployment. The relationship between the Pages deployment and the current Worker should be confirmed before changing deployment wiring.
- The public dashboard states that it requires an active Telegram-linked business session. An unauthenticated page read shows initial loading/empty placeholders; this is not evidence that authenticated data loading is broken. A signed-in browser walkthrough remains outstanding.
- The public footer/source link points to the old repository `thisishaidee/liquidity-coordination-core`, not the current `thisishaidee/nerith` repository. This is a confirmed website-content defect.
- The public control page distinguishes workspace creation, wallet registration, Telegram linking, x402 budgets and payment approvals; wallet registration itself does not move funds or grant signing authority.

## 3. Telegram

Confirmed:
- Production Worker health reports Telegram configuration present.
- All four Telegram secret bindings are present by name.
- Public Telegram profile `https://t.me/NerithLiquidityBot` resolves as **NERITH | Liquidity Coordinator**.
- Production Worker includes webhook, linking, status/setup, command, approval and notification-outbox routes in source.

Not yet verified:
- Telegram's actual webhook registration/status.
- A live `/start` → private business link → command response round-trip.
- Notification delivery from a real operation-state change.
- Approval/rejection and role enforcement using real linked Telegram identities.

The isolated mainnet test Worker intentionally has no Telegram bot token/webhook secrets; its health endpoint reports `telegramConfigured=false`. Telegram testing must use production's configured bot or a separately provisioned test bot, never by copying production secrets into the isolated test environment.

## 4. Wallet, payments and transaction lifecycle

### Production main branch

Main contains wallet registration and confirmed SOL/USDC balance synchronization, liquidity reservations, forecasts, Swap.io/Hermes x402 quote and unsigned transaction preparation, signature tracking and conversion-status verification.

Important distinction: the existing production reservation system is an internal ledger hold. It is not an on-chain transfer. The existing conversion preparation path returns an unsigned swap transaction for a business-controlled signer; it does not itself prove that a wallet signed, broadcast, or settled the swap.

### Candidate PR #52

PR #52 adds a much more complete payment-intent candidate:
- Wallet ownership proof and explicit wallet roles.
- Payment-policy checks and idempotent payment preparation.
- Atomic USDC/SOL reservation accounting and funding legs.
- Unsigned checked-USDC transaction construction.
- Wallet Standard signing handoff.
- Worker-side signed-message/signature/instruction verification and broadcast.
- Finalized-RPC settlement and network-fee reconciliation.
- A final-payment gate after reserve replenishment is finalized.

Latest PR #52 CI run `43634742709` passed:
- Hermes unpaid-402 challenge capture.
- Typecheck and complete automated test suite.
- Worker dry-run.
- Local Worker/D1 integration replay.

The deploy job was skipped. The unpaid 402 challenge is not a paid x402 transaction. The local integration is not a funded wallet transaction.

### Explicit wallet/payment release gaps

The candidate's own release audit records:
1. No funded wallet transaction has been demonstrated.
2. Real Android Wallet Standard discovery/signing/return flow remains untested.
3. iOS and desktop wallet coverage remain untested.
4. WalletConnect-specific and platform deep-link adapters are not implemented/verified; do not claim universal WalletConnect or Telegram Mini App signing support.
5. Reserve-replenishment and final-payment legs still need a real devnet signing, broadcast and finalized reconciliation test.
6. A successful paid Swap.io x402 payment/receipt has not been demonstrated.
7. Conversion/swap settlement is separate from the checked-USDC funding-leg execution flow; do not conflate the two.

## 5. Isolated mainnet test environment

Cloudflare confirms a separate Worker `nerith-mainnet-testing` and separate D1 database `nerith-mainnet-testing`. Its health endpoint reports database connected. Its D1 schema has migrations through `0032_funding_leg_fee_ledger.sql`.

The isolated database currently contains 1 business, 1 agent, 2 wallets and 0 operations. This differs from the earlier PR description that said the test database had zero business/agent records; current database state is authoritative.

This environment is isolated from the production D1 binding and has no Telegram secrets. It is the appropriate place to continue controlled wallet/payment tests after reviewing the candidate.

## 6. Production migration verification limitation

The current `main` branch contains migrations `0001` through `0024`. PR #52 adds migrations `0025` through `0032`. The isolated test D1 confirms all 32 candidate migrations are applied.

The Cloudflare D1 listing shows the production database UUID and the Worker runtime health query confirms D1 is connected. However, direct Cloudflare D1 management API reads/queries against that listed production UUID returned a not-found response during this audit, so the exact production `d1_migrations` state could not be independently read through that API call. Do not assume migrations 0025–0032 exist in production; they are not in main and PR #52 explicitly says they have not been applied.

## 7. Prioritized findings

| Priority | Finding | Required action |
|---|---|---|
| Critical | Payment-intent/wallet-ownership candidate is not production code | Review PR #52 against main, test in isolated environment, then make a separate release decision |
| Critical | No funded transaction round-trip proven | Complete devnet wallet signing, broadcast and finalized settlement tests |
| Critical | No paid x402 settlement proven | Complete a genuine low-value paid challenge/receipt test |
| High | Multi-wallet role/planner work remains unmerged | Review PR #51 and integrate only after ownership/payment model is reconciled |
| High | Telegram runtime configured but webhook/command flow unverified | Check authenticated webhook status, linking, commands, approvals and outbox delivery |
| High | Production migration state 0025–0032 not established | Verify production D1 migration ledger and active reservations before any migration |
| Medium | Live dashboard authenticated data flow not browser-tested | Complete signed-in Android and desktop walkthrough |
| Medium | Website points to old GitHub repository | Update footer/source link to current repository |
| Medium | Pages deployment timestamp predates current Worker deployment | Confirm Pages-to-Worker routing/deployment relationship before deployment changes |

## 8. Safe next sequence

1. Review PR #52 and PR #51 together; do not merge either blindly.
2. Establish the production D1 migration ledger and preserve all active/ambiguous reservations.
3. Use the isolated test Worker and D1 for real Android wallet discovery, ownership proof, signing, broadcast and finalized settlement.
4. Test reserve replenishment and final payment as two separate finalized legs.
5. Test genuine paid x402 settlement separately from the swap transaction.
6. Verify Telegram webhook and complete the real command/notification/approval round-trip.
7. Run authenticated website smoke tests at narrow Android and desktop widths.
8. Only then prepare a production migration/deployment plan.

**No production secrets were read, copied, rotated or exposed. No production D1 writes, wallet signing, broadcasts, payment attempts, merges or deployments were performed during this audit.**
