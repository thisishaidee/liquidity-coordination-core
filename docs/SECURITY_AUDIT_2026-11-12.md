# NERITH security audit — static review

**Review date:** 12 November 2026  
**Scope:** current `main` source for the Worker, D1 schema/migrations, Telegram TOTP helper, and browser pages.  
**Method:** source review and documented test/CI evidence. This is not a penetration test, independent smart-contract audit, live paid x402 test, or complete browser/device QA.

## Executive assessment

NERITH has several sound security boundaries: agent API keys are stored as SHA-256 hashes; admin sessions are random, hashed, HttpOnly, Secure and SameSite=Strict; Telegram webhook requests are checked against Telegram's secret-token header; TOTP seeds are AES-GCM encrypted; the Swap.io upstream host is fixed; provider quotes are cached server-side; the Worker does not sign or broadcast transactions; and finalized conversion status is checked against Solana RPC.

The system is **not ready to be represented as a fully secured multi-tenant production funds platform**. The most important gaps are business-level authorization, source-asset debit verification, rate limiting and x402 spending controls. The current product should be described as a controlled operator deployment and transaction-preparation/coordination layer.

## Findings

### High — Admin authority is global, not business-member scoped

**Evidence:** `isAdmin` accepts the global `ADMIN_BOOTSTRAP_TOKEN` or any unexpired `nerith_admin_session`. The session is not bound to a business ID or a user identity. Business dashboard and setup endpoints then accept a caller-supplied business ID while relying on this global operator authorization.

**Impact:** anyone who obtains the bootstrap token or an admin session can access or mutate the administrative surface across businesses. There is no customer login, business membership model, or per-business role enforcement.

**Current mitigation:** keep the bootstrap token private, restrict access to the operator, and do not onboard unrelated businesses into the same deployment.

**Required fix before multi-customer launch:** implement authenticated users, business membership, role-based access control, business-bound sessions and audit logging. Bind each session to its authorized business set and enforce it on every admin endpoint.

### High — Conversion settlement does not verify the source SOL debit

**Evidence:** `getSwapStatus` verifies that the registered operating wallet signed the finalized transaction and calculates the increase in USDC owned by that wallet. It compares the USDC increase with the operation's shortfall. It does not currently verify the SOL debit against the reserved source amount or account for network fees/rent.

**Impact:** a transaction could deliver enough USDC while consuming more SOL than the amount NERITH reserved. The operation could be classified as settled without a complete check of the swap's input-side economics.

**Required fix:** verify the source asset movement from finalized transaction metadata, using the reserved amount and a carefully specified fee/rent policy. Reject or mark unverified any transaction whose source debit cannot be reconciled. Add tests for normal swaps, excess debit, missing metadata, wrapped-SOL account flows, fees, rent and failed transactions.

### High — No application-level rate limiting

**Evidence:** source review found no general per-agent, per-IP, per-business or per-Telegram-user rate limiter. The README also lists rate limiting as future work.

**Impact:** leaked agent keys can be used for request floods, resource exhaustion, and repeated paid quote/build attempts. Admin and Telegram endpoints also lack a consistent application-level throttle.

**Required fix:** add Cloudflare edge rate limits and application-level quotas. Use different policies for authentication, read endpoints, request creation, conversion quote/build, Telegram commands and TOTP verification. Return 429 with retry guidance and log abuse without recording secrets.

### High — x402 API reserve has a minimum balance gate but no spend budget

**Evidence:** conversion validation requires a fresh `api_payment` USDC snapshot with at least 0.01 USDC available. No per-agent, per-business, per-day or per-operation x402 spend budget is enforced in the reviewed conversion flow.

**Impact:** an authorized or compromised agent can repeatedly initiate paid Swap.io API operations, subject to the upstream payment wallet's available funds and the x402 client's signing policy.

**Required fix:** define business-approved limits for total API spend, per-agent spend, quote/build frequency and operation-level retries. Reserve or account for API-payment costs separately, reconcile receipts, and require explicit business configuration for higher limits.

### Medium — Telegram webhook update idempotency needs stronger coverage

**Evidence:** the webhook validates Telegram's secret token and private-chat constraint, and task creation has a duplicate task guard. A general durable deduplication check for Telegram `update_id` is not evident in the reviewed webhook entry point.

**Impact:** Telegram retries or duplicated updates could repeat command-side effects in paths that do not independently enforce idempotency.

**Required fix:** persist processed update IDs with a unique constraint and make callback/command handlers idempotent. Add replay tests for message updates and approval callbacks.

### Medium — Swap settlement relies on a narrow upstream receipt check

**Evidence:** `proxyHermes` accepts a paid HTTP 200 response when the Hermes `X-PAYMENT-RESPONSE`/ `PAYMENT-RESPONSE` header decodes to JSON with `success: true`.

**Impact:** the Worker trusts Hermes as the x402 verifier and does not independently validate every receipt claim such as network, asset, amount, recipient and transaction reference.

**Current boundary:** the receipt is returned by the fixed HTTPS Hermes host, not accepted from the caller. This is a trust-in-upstream design, not a demonstrated bypass.

**Recommended improvement:** validate the receipt schema and bind the receipt's payment identity/amount/network to the requested endpoint charge where the upstream protocol exposes those fields. Preserve raw receipt evidence in a safely redacted audit record.

### Medium — No explicit x402 request timeout or upstream response-size ceiling

**Evidence:** `proxyHermes` awaits the fixed upstream fetch and reads the full response body with `arrayBuffer()`. No explicit abort timeout or body-size cap is visible in that helper.

**Impact:** a slow or unexpectedly large upstream response can consume Worker execution resources.

**Required fix:** use an AbortController timeout, cap response bytes before buffering/parsing, and return a bounded 502/504 error.

### Medium — Inline-script CSP weakens XSS containment

**Evidence:** HTML responses use a Content Security Policy that permits `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`.

**Impact:** if a future HTML injection bug is introduced, the policy provides less protection than a nonce/hash-based CSP.

**Current mitigation:** dynamic UI strings in the reviewed agent/business dashboard templates are generally passed through HTML escaping before interpolation; control UI uses DOM text APIs for much of its dynamic content.

**Recommended improvement:** move inline scripts/styles to versioned assets or adopt nonce/hash-based CSP, then add an automated check for unsafe HTML sinks and unescaped dynamic values.

### Low — Production security headers can be strengthened

**Evidence:** HTML responses set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a restrictive frame policy in CSP. HSTS and an explicit Permissions-Policy are not set in the reviewed Worker responses.

**Recommended improvement:** set HSTS at the edge after confirming HTTPS-only routing, add a restrictive Permissions-Policy, and keep cache-control no-store on authenticated/private responses.

### Low — Documentation has a stale statement about API-key rotation

**Evidence:** the API route and implementation include agent key rotation, while the README's future-work list still says API-key rotation remains future work.

**Fix:** update the documentation to state that rotation is implemented; user login, business-scoped authorization and rate limiting remain future work.

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

1. Live paid x402 quote and build using a controlled low-value test wallet.
2. Full Solana test swap from quote through unsigned build, local signing, broadcast, finalization and reconciliation.
3. Negative settlement tests for wrong signer, wrong output mint, insufficient output, excessive SOL debit, missing transaction metadata and failed transactions.
4. Business-isolation tests using two distinct businesses and sessions.
5. Rate-limit and abuse tests for agent API, admin login, Telegram commands and paid conversion routes.
6. Telegram end-to-end tests for linking, permission changes, request creation, independent approval, TOTP self-approval, replayed updates and expired challenges.
7. Actual Android/mobile and desktop visual QA. Source breakpoints exist, but rendered screenshots have not been verified in this audit.

## Release recommendation

Continue controlled internal testing. Do not claim audited, trustless, fully autonomous or production-ready funds execution. Close the two High findings around business authorization and source-debit settlement verification, implement rate limits and x402 spend budgets, then run the outstanding end-to-end tests before onboarding external businesses.
