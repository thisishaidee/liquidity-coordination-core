# NERITH static security and release-readiness audit

**Date:** 14 November 2026  
**Review target:** `feat/solana-wallet-ownership-proof`  
**Review type:** Static application, API, transaction-verification, database-migration and CI review  
**Status:** Candidate implementation only. This is not an independent penetration test, formal smart-contract audit, or certification.

## Executive assessment

The candidate has meaningful security controls: business-scoped admin sessions, role-gated writes, wallet ownership challenges, explicit wallet roles, bounded payment policy, idempotency, managed USDC/SOL reservations, signed-transaction verification, exact SPL Token transfer checks, and finalized-only settlement reconciliation.

**Release decision: not approved for production funds yet.** The automated suite and Worker/D1 integration provide useful evidence, but they do not demonstrate a funded wallet round-trip, a real mobile wallet signing flow, or a successful paid Hermes x402 settlement. Production migrations and deployment have not been applied.

## Review coverage

- Admin authentication, role checks, business scoping and browser-origin checks
- Agent authentication, treasury permission and request rate limiting
- Wallet ownership proof and role assignment boundaries
- Payment policy, allowlists, per-transaction/daily limits and idempotency
- D1 managed reservations, funding-leg lifecycle and aggregate fee ledger
- Unsigned transaction construction and fully signed transaction verification
- Worker broadcast/retry and finalized settlement reconciliation
- Dashboard payment workflow, mobile navigation and responsive source tests
- CI/deployment gates and the accuracy of product/security claims

## Findings and disposition

### F-01 — Retry path could reject a transaction that had already finalized

**Severity:** High operational risk  
**Status:** Fixed in this branch; CI pending

The signed-funding retry path previously checked recent-blockhash validity before looking up the already-recorded transaction signature. A valid transaction can finalize and then have its recent blockhash expire. In that case the retry path could return an expired-blockhash error without reconciling the finalized transaction, leaving the funding leg and its reservations stuck in submitted state.

The retry path now checks the recorded signature with transaction-history lookup first. A finalized signature is sent to the normal finalized reconciliation path; a visible non-finalized signature remains pending; only an unobserved signature proceeds to blockhash validity checks. The retry must continue using the exact same signed payload.

### F-02 — Real wallet signing and funded settlement are not demonstrated

**Severity:** Critical release gate  
**Status:** Open; requires external device and funded-wallet testing

The browser implements Wallet Standard transaction signing, and the Worker verifies the signed legacy transaction before broadcast. Automated tests do not prove that a real Android wallet discovers the app, signs both required signer slots in sequence, returns the partially/fully signed bytes correctly, and completes the browser return flow.

No funded reserve-replenishment or final-payment transaction has been demonstrated on-chain. Do not enable production payment execution until the complete round-trip and finalized reconciliation have passed with a deliberately small test amount.

### F-03 — Hermes evidence is an unpaid challenge, not a paid x402 settlement

**Severity:** High evidence/claims risk  
**Status:** Open; explicitly disclosed

The CI Hermes probe demonstrates that the upstream endpoint returns an HTTP 402 payment requirement. The local Worker/D1 integration proves that NERITH relays and persists that challenge. Neither proves that NERITH paid the challenge, that a paid request was accepted, or that a real receipt was finalized and reconciled. Submission language must preserve this distinction.

### F-04 — Cross-platform wallet support is incomplete

**Severity:** High release gate  
**Status:** Open; documented limitation

The current signing implementation is Wallet Standard-based. WalletConnect-specific, platform deep-link, and Telegram Mini App wallet adapters are not implemented or verified. Do not describe those platforms as supported. Desktop and iOS device coverage also remains unverified.

### F-05 — Responsive checks are source-level, not device QA

**Severity:** Medium release gate  
**Status:** Open; requires device walkthrough

The responsive test suite checks source-level layout contracts and mobile navigation markup. It is not a screenshot or real-device test. Complete a narrow Android viewport walkthrough covering dashboard navigation, payment inbox, long wallet/transaction identifiers, approval controls, loading/error states and the signed-transaction return flow.

### F-06 — Production database and deployment gates remain unapplied

**Severity:** Critical release gate  
**Status:** Open; production changes intentionally not made

Migrations 0025–0032 are part of the candidate branch. They have not been applied to production D1 and the candidate Worker has not been deployed. Review migration preconditions and existing active reservations against a production snapshot before applying them. Preserve ambiguous or submitted holds; never manufacture fee or settlement evidence to make historical rows pass.

## Security controls observed

- Admin session tokens are random, stored as SHA-256 hashes, expire, and are delivered in HttpOnly, Secure, SameSite=Strict cookies scoped to the admin API path.
- Admin writes require an allowed browser Origin. Admin sessions are role-gated; analyst access is read-only.
- Admin resource access checks the session business against the requested business or resource business.
- Agent credentials are hashed before lookup; payment preparation requires active agent status and explicit business-treasury permission.
- Payment requests validate destination keys, use business-scoped idempotency, and enforce policy allowlists and spend limits.
- Wallet ownership verification is separate from wallet role and execution authority.
- Funding transactions are constrained to one exact checked-USDC SPL Token transfer with expected source/destination ATAs, mint, amount, decimals, fee payer and required signatures.
- The Worker records the transaction signature before broadcast. Broadcast is not represented as settlement.
- Reconciliation reads the stored signature and requires finalized RPC evidence; uncertain outcomes do not release holds.
- Aggregate SOL fee reservations are tracked separately from USDC payment reservations. Conversion remains outside this execution path.
- CI runs typecheck, the test suite, Worker dry-run and isolated Worker/D1 integration. Production deploy is limited to pushes to main.

## Required pre-production tests

1. Real Android Wallet Standard discovery and connection.
2. One wallet serving as both fee payer and token owner.
3. Two distinct wallets signing the same unchanged transaction message.
4. User rejection, wallet disconnect, app backgrounding, timeout and browser return.
5. Wrong business, wrong role, revoked wallet, stale balance, expired intent and replayed signature.
6. Duplicate/concurrent prepare, submit and reconcile requests.
7. Broadcast timeout followed by retry with the same signed payload.
8. Finalized transaction whose blockhash has since expired (regression for F-01).
9. Processed/confirmed-but-not-finalized transactions remain pending.
10. Wrong mint, destination, amount, decimals, signer, ATA, extra instruction and failed transaction are rejected.
11. Reserve replenishment must finalize before final-payment preparation; final payment must independently finalize before the intent is confirmed.
12. Actual network fee is reconciled per leg and within the aggregate cap.
13. Verify all relevant screens at 320–360 CSS px and a wider desktop viewport.

## Operational safeguards

- Start on devnet with test tokens and a separate non-production D1 database.
- Use a dedicated low-balance test wallet; never use a primary treasury wallet for first-run tests.
- Keep transaction amounts deliberately small and confirm the exact destination and token mint in the wallet before signing.
- Do not paste API tokens, private keys, seed phrases, or wallet secrets into chat, issues, logs or screenshots.
- Keep production deployment and production migration application as separate, explicitly reviewed actions.
- Obtain an independent security review before real customer funds or autonomous execution are enabled.

## Audit limitations

This review is static and repository-based. It did not run a live penetration test, fuzz the deployed Worker, inspect Cloudflare production secrets or D1 contents, independently validate upstream RPC/provider behavior, or sign/broadcast a real transaction. No claim of “fully secure”, “audited by a third party”, or “production ready” is justified by this document.
