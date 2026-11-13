# NERITH security audit — static review

**Review date:** 12 November 2026  
**Scope:** current `main` source for the Worker, D1 schema/migrations, Telegram TOTP helper, and browser pages.  
**Method:** source review and documented test/CI evidence. This is not a penetration test, independent smart-contract audit, live paid x402 test, or complete browser/device QA.

## Executive assessment — updated 13 November 2026

The initial 12 November review identified several controls that were subsequently implemented. The current main branch includes the rate-limit, Telegram replay and Hermes resource controls from PR #29; finalized SOL source-debit reconciliation from PR #30; challenge-bound x402 payment budgets and on-chain receipt verification from PR #31; and business-bound admin sessions from PR #37. PR #37 is merged, its CI passed, migration 0023 applied successfully to production D1, and the Worker deployment completed successfully.

The current implementation is materially stronger, but it is not an independent penetration test or a complete proof of safe production funds execution. The remaining major limitations are the shared platform bootstrap credential, lack of individual admin identities and role-based membership, incomplete rate-limit coverage, no live paid x402 end-to-end test, and no full instruction-by-instruction policy audit of swap transactions.

## Current findings

### High — Individual admin identities and role-based membership are not implemented

**Current evidence:** ordinary admin workspace endpoints now require an HttpOnly session bound to one business. The Worker checks the session's business ID against the requested business and resolves the owning business from D1 for agent, wallet, balance-snapshot and x402-reservation ID actions. Unknown admin routes fail closed. The platform-wide `ADMIN_BOOTSTRAP_TOKEN` is accepted only for workspace bootstrap, session establishment, shared Telegram bot setup/status and manual reservation expiry. Migration 0023 invalidated legacy unscoped sessions.

**Residual limitation:** the platform bootstrap token remains a shared operator-level root credential. There is no individual human identity, business membership table or per-user role model. Anyone who obtains that root credential can establish a session for any business.

**Mitigation:** keep the token in Cloudflare Worker secrets, never place it in browser storage, restrict it to the operator, and use only business-bound sessions for normal workspace work. Cookie-authenticated mutations require a same-origin `Origin` header. Resource-ID routes compare the resource's D1 owner with the session business.

**Required before open multi-customer SaaS:** add individual sign-in, business membership, role-based permissions and attributable admin audit events. Business-bound sessions are an important isolation boundary, not a substitute for user identity and RBAC.

### Medium — Rate limiting does not cover every surface

**Current evidence:** PR #29 added persistent per-agent fixed-window limits for selected sensitive routes: quote, build, request creation, tracking and status polling. Request bodies are capped at 256 KB. Telegram update IDs are deduplicated, and Hermes requests have a 12-second timeout, redirect rejection and bounded quote/build responses.

**Residual limitation:** these limits do not amount to a universal per-IP, per-business, per-admin-login or per-Telegram-user abuse policy. Other routes and platform-wide authentication surfaces still need deliberate coverage.

**Recommended improvement:** expand and test route-specific limits, including bootstrap/session attempts, admin reads/writes, Telegram command and callback paths, and any additional paid endpoints. Keep monetary x402 budgets separate from request-count throttles.

### Medium — Paid x402 operation has not passed a live end-to-end test

**Current evidence:** PR #31 stores the exact Hermes V1 Solana-USDC payment challenge, binds it to the agent, business, operation, request body and registered API-payment wallet, and atomically reserves the challenged amount against per-agent and per-business daily budgets before forwarding payment. Defaults are 0.01 USDC per agent per day and 0.05 USDC per business per day. Finalized receipt verification checks the challenged payer, mint, amount, recipient and parsed USDC transfer; ambiguous payment states remain reserved.

**Residual limitation:** this has passed source review and automated tests, but no controlled low-value live paid Hermes request and full failure/retry exercise has been completed. The budgets cover paid Hermes calls routed through NERITH, not direct transfers made outside the service.

**Required verification:** use a funded, controlled x402 payment wallet to test quote, build, receipt verification, duplicate/replay rejection, timeout and reconciliation without exposing private keys.

### Medium — Settlement checks reconcile net asset movements, not every swap instruction

**Current evidence:** PR #30 verifies the registered operating wallet's finalized native SOL debit against the reserved source amount, applicable network fee and evidenced rent for newly created, still-open wallet-owned USDC/WSOL accounts. PR #31 independently checks the exact challenged USDC payment transfer for x402 charges.

**Residual limitation:** the SOL check is net-debit reconciliation, not a full instruction-by-instruction audit of every possible upstream swap route. Live end-to-end swap execution and negative transaction cases remain outstanding.

**Required verification:** complete a controlled test swap from quote through unsigned build, business-controlled signing, broadcast, finalization and settlement reconciliation. Exercise wrong signer, wrong mint, insufficient output, excess source debit, missing metadata, failed transaction and ambiguous RPC cases.

### Medium — Inline-script CSP weakens XSS containment

**Evidence:** HTML responses still permit inline scripts and styles through the Content Security Policy.

**Impact:** a future HTML injection bug would have less containment than under a nonce- or hash-based policy.

**Recommended improvement:** move inline scripts/styles to versioned assets or adopt nonce/hash-based CSP, then add automated checks for unsafe HTML sinks and unescaped dynamic values.

### Low — Production security headers can be strengthened

**Evidence:** the reviewed Worker responses set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a restrictive frame policy in CSP. HSTS and an explicit Permissions-Policy were not present in the reviewed responses.

**Recommended improvement:** set HSTS at the edge after confirming HTTPS-only routing, add a restrictive Permissions-Policy, and keep authenticated/private responses `no-store`.

## Positive controls observed

- Agent API keys are high-entropy random values; only their SHA-256 hashes are stored.
- Agent authentication checks active status and all agent operation reads/writes are scoped by agent ID.
- Admin session cookies are HttpOnly, Secure, SameSite=Strict, path-scoped and stored hashed in D1.
- Unsafe cookie-authenticated admin mutations require a same-origin `Origin` header.
- Telegram webhook updates require the configured Telegram secret-token header and private chat for command handling.
- Telegram link codes are hashed, time-limited and single-use.
- TOTP secrets are encrypted with AES-GCM; enrollment attempts are capped; TOTP time steps are single-use; self-approval challenges expire and bind to an operation snapshot.
- Hermes is a fixed upstream host; callers cannot submit arbitrary URLs.
- Swap quotes are held in D1 and referenced by a server-issued quote ID; build revalidates the operation and quote.
- Minimum USDC output is checked before transaction preparation.
- The Worker does not hold private keys or sign/broadcast swaps.
- Settlement polling uses Solana RPC and does not require another paid Hermes request.
- Manual balance snapshots are explicitly admin-only and are not described as on-chain verified.

## Verification still required

1. Live low-value x402 quote/build payment and a controlled failure/retry/reconciliation exercise.
2. Full Solana test swap from quote through unsigned build, business-controlled signing, broadcast, finalization and settlement.
3. Production smoke test using two distinct businesses to confirm session creation, cross-business denial and resource-ID ownership checks after migration 0023. Automated cross-business and resource-ID isolation tests pass in CI.
4. Broader rate-limit and abuse tests for admin authentication, non-limited agent routes, Telegram commands and callbacks.
5. Telegram end-to-end tests for linking, permission changes, request creation, independent approval, TOTP self-approval, replayed updates and expired challenges.
6. Actual Android/mobile and desktop visual QA. Source breakpoints and page-script tests exist, but rendered screenshots and touch interactions have not been verified in this audit.

## Release recommendation

The business-scoped authorization change is merged and deployed, and the production Worker health endpoint reports `ok` with D1 connected. Continue controlled internal testing. Do not describe NERITH as independently audited, trustless, fully autonomous or as a fully production-proven funds execution system. Before open multi-customer onboarding, add individual admin identities and role-based permissions, complete live x402 and swap tests, broaden abuse controls, and finish rendered mobile/desktop QA.

## Follow-up hardening PR #29 (merged and deployed; current status updated above)

The follow-up branch adds the following controls:

- Per-agent fixed-window limits: swap quote 4 per 10 minutes; swap build 3 per 10 minutes; liquidity request creation 20 per minute; swap tracking 20 per minute; swap status polling 30 per minute.
- Bounded JSON request parsing at 256 KB.
- Telegram update-id deduplication with a two-minute processing lease, retry after an interrupted handler, and 30-day retention.
- Hermes upstream timeout of 12 seconds, redirects rejected, quote response cap of 1 MB, build response cap of 512 KB, and explicit handling of interrupted/oversized upstream responses.
- Scheduled cleanup for old limiter and replay records.

At the time PR #29 landed, these were abuse and resource controls rather than a complete x402 monetary budget. PR #31 subsequently implemented challenge-bound per-agent and per-business USDC budgets and finalized on-chain payment receipt verification, as described in the current findings above. Request-count limits and monetary spending budgets remain separate controls.

The SOL settlement verifier now reconciles the finalized operating-wallet native SOL debit against the exact reserved input, any network fee paid by that wallet, and evidenced rent for newly-created, still-open USDC/WSOL token accounts owned by that wallet. It fails closed on unexplained or incomplete debits. This is net-debit reconciliation, not a full instruction-by-instruction swap policy audit; live end-to-end swap testing remains required.

PR #29 passed typecheck, tests and Wrangler dry-run; its production D1 migration and Worker deployment completed successfully in the main-branch workflow.


## Follow-up settlement verification PR

The settlement verifier now compares the registered operating wallet's finalized native SOL balance delta against the exact source reservation amount, any network fee paid by that wallet, and only evidenced rent for newly-created, still-open USDC/WSOL token accounts owned by that wallet. The verifier fails closed on incomplete balance metadata, signer mismatch, unexplained excess debit, or a debit that does not reconcile. Unit tests cover fee payer attribution, token-account rent evidence, excess debit, under-debit, wrong ownership, signer failure and incomplete metadata.

This check is a net-debit reconciliation. It does not replace a full transaction-instruction policy audit or an end-to-end live swap test.


## x402 spend controls follow-up

The NERITH Worker now stores the exact Hermes V1 Solana-USDC payment challenge per agent, operation and request. It reserves the challenge amount atomically against both a per-agent and per-business daily budget before forwarding X-PAYMENT. The defaults are 0.01 USDC per agent/day and 0.05 USDC per business/day; authenticated admins can read and change these limits at GET/POST /v1/admin/x402/budgets. Zero disables paid calls at that scope.

A payment is counted as settled only after the X-PAYMENT-RESPONSE transaction is available at finalized commitment and its parsed transaction contains the exact challenged USDC TransferChecked from the configured payment wallet to the challenged recipient, with the advertised facilitator as fee payer. Payment payload hashes and challenge IDs are unique to prevent replay. Ambiguous timeouts, missing receipts and RPC uncertainty retain a pending budget reservation; they are not automatically released.

These controls cover paid Hermes calls routed through NERITH, not independent transfers from the same wallet outside the service. Live low-value Hermes payment testing and a controlled failure/retry exercise remain required before treating the entire payment path as operationally proven.


## Follow-up business-scoped admin authorization PR #37 (merged and deployed)

PR #37 binds every new admin session to one validated business ID. Migration `0023_admin_session_business_scope.sql` adds the business foreign key and invalidates legacy unscoped sessions. The admin route allowlist distinguishes platform-wide routes from business-scoped routes; the bootstrap token cannot access ordinary business endpoints. Agent, wallet, manual balance and x402 reservation actions resolve resource ownership from D1 and compare it with the session's business. Unknown admin routes fail closed.

The Control page now sends the selected business ID during session establishment, clears the platform token from browser memory and password fields after success, and prompts for the platform token again only for shared Telegram bot controls. CI passed typecheck, the full test suite and Wrangler dry-run. The main-branch deployment applied migration 0023 to production D1 and deployed the Worker successfully. The live health endpoint was checked after deployment and returned `status: ok` with `database: connected`.

This closes the original cross-business admin-session gap for the current operator-managed workspace model. It does not implement individual user identities, business membership or role-based permissions.
