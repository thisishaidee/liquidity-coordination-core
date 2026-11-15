# Solana Funding Transaction Builder — Implementation Contract

## Status

The unsigned USDC transaction builder and owner-only prepare endpoint are implemented on the draft branch with unit coverage. The signed-transaction verifier and owner-only Worker broadcast route are now implemented with unit coverage. The wallet transaction-signing UI, multi-wallet sign/return handoff, and real-wallet device test are not implemented yet.

The draft branch pins:
- `@solana/web3.js` 3.2.1
- `@solana-program/token` 0.18.0

Use the v3 SDK family and generated Token Program instructions. Do not combine web3.js v3 with legacy `@solana/spl-token`: Solana's current guidance says the legacy SPL package depends on web3.js v1 and is not compatible with v3.

## First supported transaction

Build only one USDC SPL Token Program transfer for one immutable funding leg. No SOL conversion, swap, Token-2022, arbitrary instructions, or batched multi-leg transaction.

All authoritative values come from the authenticated intent, funding leg, business wallet registrations, configured USDC mint and on-chain state. The route is `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/prepare?businessId=...`. It returns an unsigned base64 transaction, message digest, blockhash lifetime, fee estimate and required signer addresses. It does not change ledger state, request signatures or broadcast. Never trust browser-supplied amount, mint, source, destination, fee payer or token-account address.

## Pre-build checks

1. Resolve the leg under the authenticated business session. Require an eligible unsigned state, active matching reservation and unexpired intent.
2. Load registered source-token owner and registered SOL fee payer independently. Both must be active and ownership-verified; they may be the same wallet.
3. Fetch the configured mint from the configured HTTPS RPC. Confirm its account owner is the canonical SPL Token Program, decode it with the SDK and require exactly six decimals.
4. Derive source and destination ATAs using the mint's actual token program. Confirm the source ATA exists, is owned by the registered source wallet, uses the configured mint and has sufficient finalized spendable balance.
5. Require the destination ATA to already exist and verify its mint and owner. If it is absent, stop without constructing a transaction. ATA creation would debit rent-exempt SOL in addition to network fees; the current fee ledger has no separate rent budget or reservation.
6. Obtain a fresh blockhash and last-valid block height. Build a legacy-format transaction for broad wallet compatibility; RPC readers must still accept legacy, v0 and v1 finalized transactions.

## Instruction and fee policy

The transaction may contain only:
- The canonical idempotent ATA creation instruction, only when required for the approved recipient and mint.
- One checked SPL Token transfer for the exact reserved atom amount, configured USDC mint and six decimals.
- No arbitrary System Program, Memo, swap, token approval, delegate, close-account, authority-change or unknown program instruction.
- No priority-fee or compute-budget instruction until a separately reviewed policy defines its maximum and accounts for the additional fee.

Set the fee payer before compiling the message. Estimate the message fee from RPC after all instructions and required signers are fixed. Reject if the estimate exceeds the per-transaction cap or remaining aggregate fee budget. Also verify finalized source-token balance covers all active USDC reservations plus the source wallet's configured minimum remaining balance, and finalized fee-payer SOL covers all active SOL reservations plus its configured minimum. D1 reservation remains the authoritative ceiling.

## Frozen-message and multi-wallet signing

1. Compile once and serialize the message bytes.
2. Record a digest of those bytes with funding-leg ID, fee payer, source owner, destination, mint, amount, blockhash and last-valid block height.
3. Show a human-readable transaction summary before opening a wallet.
4. Request the fee-payer signature if distinct; then request the source-owner signature if distinct and still missing.
5. Each wallet signs only for its own public key. Preserve signatures already collected.
6. After every wallet response, compare message bytes byte-for-byte with the frozen message. Reject any change to fee payer, blockhash, account keys, signer set, instruction order, program IDs or instruction data.
7. Verify each signature against its required signer and frozen message. Never broadcast while any required signature is absent or invalid.
8. Cancellation, provider switching, session loss or expired blockhash leaves the leg unsigned and reservations intact. A refreshed blockhash creates a new message and requires every signer again.

An ownership challenge, provider connection, Telegram identity or admin session is not a transaction signature.

## Submission and settlement

- The `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/submit-signed` endpoint accepts signed serialized bytes plus the prepared message digest. It verifies the exact one-instruction USDC transfer, signer set and cryptographic signatures, confirms the blockhash remains valid, checks the fee cap, records the signature before broadcasting and supports safe retry of the same signed payload. Finalized reconciliation remains separate. The multi-wallet UI and real device handoff remain release gates.
- After broadcast, store the signature against the funding leg and fee-ledger row atomically. A timeout after broadcast is ambiguous; query the signature before retrying.
- Existing finalized-RPC reconciliation remains the source of truth: exact SPL transfer, source-owner signer, fee-payer signer, actual fee, fee cap, slot, signature and finalized balance deltas.
- Reject additional transfers and unapproved instructions.
- Do not release USDC or SOL reservations for submitted or ambiguous transactions until finalized outcome and actual fee are reconciled.

## Required tests before enabling the UI

- Mint owner/program and six-decimal validation; reject wrong mint and Token-2022.
- Missing/wrong source ATA, wrong owner/mint and insufficient finalized balance.
- Destination ATA present; missing destination ATA is rejected without creating an account or spending rent.
- Fee payer equals source owner and fee payer differs from source owner.
- Missing/wrong signer, invalid signature, signature overwrite and message mutation between signers.
- Fee estimate above per-transaction cap and aggregate remaining budget.
- Expired blockhash, cancellation, duplicate submit, RPC timeout after broadcast and ambiguous retry.
- Exact transaction passes finalized verifier; extra transfer/arbitrary instruction fails.
- Unit/integration tests and responsive checks at phone, tablet and desktop widths. Real wallet handoff remains a separate device acceptance gate.

## Sources

- https://solana.com/docs/core/transactions/partial-signing
- https://solana.com/docs/clients/official/javascript
- https://solana.com/docs/tokens/basics/transfer-tokens
- https://solana.com/docs/tokens/basics/create-token-account
