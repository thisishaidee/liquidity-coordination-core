# Telegram transaction execution — implementation plan

**Status:** Required product capability; not implemented yet.
**Reviewed:** 14 November 2026
**Scope:** Telegram Bot + Telegram Mini App + existing NERITH payment-intent and signed-transaction backend.

## Product decision

NERITH must support real transaction workflows from Telegram, not only read-only notifications or request creation. Telegram is a first-class operations surface alongside the website.

The product has two Telegram surfaces with deliberately different authority:

1. **Bot chat:** create liquidity/payment requests, inspect status, receive alerts, review exact operation summaries, and record an authorised business approval. A chat approval is not a blockchain signature and must never trigger an unbounded or hidden transfer.
2. **Telegram Mini App:** open the transaction workspace inside Telegram, authenticate the Telegram launch using server-validated initData, display the exact transaction, connect a compatible Solana wallet, hand the transaction to that wallet for signing, return the signed bytes to NERITH, and use the existing Worker verification/broadcast/reconciliation path.

The user must not enter a seed phrase or private key into Telegram, the Mini App, NERITH, or an AI agent. Signing must occur in the wallet app/provider. The Mini App may need to open an external wallet and restore its Telegram/browser session after the user returns.

## What exists today

- Telegram Bot webhook, secret-token validation, update deduplication and retryable processing.
- Private chat linking with one-use, expiring invitation codes.
- Business-scoped Telegram connections and requester/approver/viewer permissions.
- Liquidity request creation and review commands.
- Google Authenticator TOTP for the existing self-approval protection.
- One-use, five-minute Telegram login tickets that open the website dashboard.
- Website payment-intent inbox, transaction preparation, Wallet Standard sequential signing, Worker signed-transaction verification/broadcast, and finalized reconciliation.

## What does not exist yet

- Telegram Mini App launch button and WebApp entrypoint.
- Server-side validation of Telegram initData (including auth-date freshness and HMAC validation).
- A short-lived Mini App session bound to Telegram user, chat, business, role, and allowed origin.
- A Telegram Mini App transaction-review screen.
- A Telegram-aware Solana wallet adapter and wallet-app deep-link/return handling.
- End-to-end Mini App signing and settlement tests on Android/iOS.
- A tested policy linking Bot approvals to the exact immutable payment-intent snapshot that the Mini App will present for signing.

The current /login command opens the website dashboard with a one-use ticket. It is not a Telegram Mini App and must not be described as one. The current Wallet Standard signing path has not passed real Android/iOS device tests.

## Intended transaction journey

1. An authorised operator sends /newrequest or opens the NERITH Mini App from the bot.
2. NERITH checks the Telegram connection, business membership, role, request limits, and current payment policy.
3. The backend creates an idempotent payment intent and reserves eligible liquidity and fees. No transaction is signed or broadcast at this stage.
4. The Bot sends an operation summary and a button to open the Mini App. Sensitive wallet and transaction details are fetched inside the authenticated Mini App, not placed in a public chat.
5. The Mini App validates the Telegram launch session and obtains the exact intent from the Worker.
6. The user reviews source wallet, destination, token mint, amount, network, fee cap, operation ID, expiry, and any sequential funding legs.
7. Where policy requires a separate approver, the Bot records approval against the exact intent ID and immutable transaction-intent digest. Self-approval safeguards remain enforced. Approval alone cannot sign or broadcast.
8. The Mini App invokes the supported wallet adapter. The wallet app displays and signs the exact transaction. The Mini App receives the signed transaction bytes after the user returns.
9. The Worker independently verifies the prepared digest, signer set, signatures, token program, mint, source/destination accounts, amount, decimals, blockhash and fee cap before broadcasting.
10. NERITH independently reconciles finalized on-chain state and actual fees. The Bot sends a verified status update with the transaction explorer link.
11. For reserve replenishment, the final payment remains unavailable until the replenishment is finalized and the payment-wallet balance is refreshed.

## Security requirements

- Validate Telegram initData server-side using Telegram's documented HMAC procedure and bot token; reject stale auth_date, malformed hashes, replayed launch tickets, and untrusted origins.
- Never trust user ID, chat ID, role, or business ID supplied by Mini App JavaScript without matching them to validated initData and active D1 membership.
- Issue a short-lived, single-purpose session after validation. Bind it to the user, business, chat, role, origin, and expiry. Support revocation and logout.
- Do not use a Telegram username as an identity key. Use Telegram numeric user ID and chat ID.
- Require HTTPS and strict origin/CSP controls. Avoid wildcard CORS.
- Do not place private keys, seed phrases, agent API keys, bootstrap tokens, or long-lived session credentials in Telegram messages, URLs, query strings, browser storage, or logs.
- Keep Bot approval, wallet ownership proof, transaction signature, broadcast, and finalized settlement as separate auditable events.
- Bind approval to the exact immutable operation snapshot/digest. Any change in amount, recipient, source wallet, mint, fee cap, or transaction message invalidates approval.
- Add expiry, idempotency, duplicate callback protection, replay protection, rate limits and explicit handling of wallet rejection, interrupted handoff, stale blockhash, timeout and ambiguous RPC results.
- Keep reserve replenishment, conversion and final payment as separate transaction legs. Never describe them as atomic.
- Use the existing Worker-side signed-transaction verifier. Do not create a Telegram-only shortcut that bypasses it.
- The Mini App must not be able to submit an unsigned transaction for broadcast or select arbitrary instructions.

## Implementation stages

### T1 — Telegram Mini App authentication
- Configure BotFather Mini App entrypoint/menu button.
- Add a dedicated Mini App route and static shell.
- Validate initData on the Worker using Telegram's official algorithm.
- Add short-lived scoped sessions and tests for invalid HMAC, stale auth date, user mismatch, replay, revoked membership and cross-business access.

### T2 — Read-only payment workspace
- Display the user's authorised business, payment intents, funding legs, balances and verified transaction statuses.
- Do not expose private treasury data to users without an active business role.
- Add narrow viewport and Telegram WebView tests.

### T3 — Transaction review and approval
- Show immutable transaction summaries and exact operation digests.
- Link Bot approval to the exact intent snapshot.
- Test requester/approver separation, self-approval TOTP, expiry, duplicate callbacks and changed-intent rejection.

### T4 — Wallet adapter and handoff
- Define an adapter interface shared with the website.
- Implement and test Telegram-compatible wallet connect/sign/return for named wallet providers.
- Preserve partially collected signatures for multiple required signers.
- Reject message mutation and wrong-wallet signing.
- Test Android Telegram WebView, wallet app switching, cancellation, refresh and return-session restoration.

### T5 — Worker execution and settlement
- Reuse prepare, submit-signed, and reconcile endpoints with Mini App-scoped owner/admin authorization.
- Never trust a Mini App status claim.
- Run tiny, explicitly approved mainnet transactions only after isolated environment and security gates pass.

### T6 — Alerts and recovery
- Bot messages report prepared, awaiting approval, awaiting wallet signature, submitted, finalized, failed or ambiguous states accurately.
- Include explorer links only for recorded signatures.
- Keep retries idempotent and never claim a broadcast is settlement.

## Acceptance criteria

- A user can start a payment workflow from Bot chat and complete review/signing in the Telegram Mini App without switching to the website, except where the wallet app itself must open.
- The exact transaction is displayed before the wallet signing prompt.
- No private key or seed phrase ever enters NERITH or Telegram.
- The same Worker verifier and finality reconciler protect website and Mini App submissions.
- A wallet rejection does not broadcast; a duplicate callback does not create duplicate payments; a changed transaction invalidates prior approval.
- Android and iOS results are reported separately and only marked supported after device testing.
- A complete end-to-end test includes on-chain finality and fee reconciliation, not merely bot approval, wallet connection or broadcast.

## Current release status

Telegram chat requests, business approvals and website login bridge exist. Telegram Mini App transaction execution is **planned, not implemented or device-verified**. Mainnet wallet testing must not be represented as Telegram support until T1–T6 acceptance criteria are met.
