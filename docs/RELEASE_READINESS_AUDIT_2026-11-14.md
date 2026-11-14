# NERITH functional and release-readiness audit

**Date:** 14 November 2026  
**Target:** `feat/solana-wallet-ownership-proof` / PR #52  
**Review type:** Repository implementation and CI evidence review  
**Decision:** Ready to enter controlled external testing; not approved for production funds or public production execution.

## Scope reviewed

- Business payment-intent lifecycle and agent treasury permission
- Business-scoped owner/admin dashboard authorization
- Wallet ownership proof and wallet-role assignment
- Multi-wallet USDC reserve replenishment and final-payment gates
- Unsigned checked-USDC transaction construction
- Wallet Standard signing handoff and Worker-side signed-byte verification
- Solana broadcast, retry, finalized settlement and network-fee accounting
- D1 migrations 0025–0032 and managed reservation triggers
- Dashboard navigation, mobile layout contracts, CI and deployment workflow
- Swap.io/Hermes x402 evidence boundaries

## Functional findings

| Area | Result | Qualification |
|---|---|---|
| Agent payment preparation | Implemented in candidate branch | Requires agent treasury permission and idempotency |
| Business wallet registration and ownership proof | Implemented | Device/wallet interoperability still needs testing |
| Multiple business wallet roles | Implemented | Each wallet must be verified and explicitly assigned |
| Atomic USDC/SOL reservation holds | Implemented | Internal ledger holds; not on-chain transfers |
| Reserve replenishment then final payment | Implemented | Final leg is gated on finalized replenishment and fresh finalized balance |
| Unsigned USDC transfer preparation | Implemented | Exact checked-transfer construction |
| Wallet signing | Wallet Standard path implemented | Real wallet and device round-trip not yet demonstrated |
| Worker signed transaction verification and broadcast | Implemented in candidate | Must pass real devnet transaction testing |
| Finalized settlement and fee reconciliation | Implemented in candidate | No funded end-to-end proof yet |
| Conversion/swap settlement | Not implemented in this flow | Do not represent Swap.io conversion as executable through these funding-leg endpoints |
| Telegram wallet handoff | Not implemented | Telegram is not a signing adapter |
| WalletConnect and platform deep links | Not implemented | Do not claim cross-platform support beyond Wallet Standard-compatible wallets |
| Responsive behavior | Source-level checks pass | Real device and screenshot QA remains outstanding |

## Automated evidence

GitHub Actions run `43608211482`, commit `125c8fe29e25dbefa9638a4360f5b6bfbe4620ff`, completed successfully on 14 November 2026:

- Typecheck and dashboard build: passed
- Vitest: 20 test files, 209 tests passed
- Local Worker/D1 integration: passed against an isolated local database
- Hermes unpaid HTTP 402 challenge capture: passed
- Production deployment job: skipped

The Worker/D1 integration explicitly uses local D1, no Cloudflare production credentials, no paid x402 payment header, no funded wallet, no signed transaction and no broadcast. This is integration evidence, not a live payment.

## Security review summary

Positive controls observed in the candidate:
- Business-scoped admin sessions, hashed session tokens, expiry, secure HttpOnly cookies and write-origin checks
- Owner/admin write permissions with analyst read-only access
- Agent credentials hashed and treasury permission checked before payment preparation
- Business-scoped idempotency, allowlists, amount caps and daily limits
- Wallet ownership proof separated from wallet role assignment
- Managed reservation database triggers, immutable funding-leg identity and transaction-hash binding
- Worker validates exact USDC mint, source/destination token accounts, amount, decimals, fee payer and required cryptographic signatures before broadcast
- Settlement is based on finalized RPC evidence; ambiguous and uncertain outcomes retain reservations
- Per-leg network fee accounting and aggregate fee budget checks

## Open release gates

1. Run the wallet flow with a dedicated low-balance test wallet on Solana devnet. Verify discovery, connection, user review, signing, browser return, Worker broadcast and finalized reconciliation.
2. Test both signer arrangements: one wallet acting as fee payer and source owner, and two distinct business wallets signing the same unchanged message.
3. Test rejection, disconnect, app backgrounding, timeout, retry, duplicate submission, replay and stale/expired intent cases.
4. Prove one reserve-replenishment transfer finalizes, then the final-payment leg is independently prepared, signed, broadcast and finalized.
5. Exercise failure cases: wrong mint, amount, destination, ATA, signer, extra instruction, failed transaction, RPC outage and expired blockhash.
6. Complete Android viewport QA and verify a desktop viewport. Wallet Standard compatibility on Android is a test target, not a universal guarantee. iOS and desktop browser-wallet coverage must be checked separately.
7. Review production D1 migration preconditions and active reservations before any production migration. Deploy only after a separately reviewed release decision.
8. If a paid Swap.io flow is a submission requirement, complete a genuine x402 payment and verify its paid response/receipt. The current 402 evidence does not satisfy this.

## Release decision

**Proceed to controlled external testing. Do not enable production payment execution yet.** The candidate is not production-deployed, migrations 0025–0032 have not been applied to production D1, and no real funded wallet transaction has been proven. This audit is repository-based and is not an independent penetration test, formal audit or certification.
