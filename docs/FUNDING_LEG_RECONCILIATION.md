# Funding-Leg Submission and Reconciliation

## Status

Design specification only. The current branch has a pure SPL-token transfer verifier and a funding-leg ledger, but no endpoint that connects an externally signed transaction to a funding leg. Nothing in this document enables signing, broadcasting, or autonomous execution.

## Trust boundary

A client-supplied transaction signature is an untrusted lookup key, not proof of payment. The Worker must retrieve transaction data from the configured Solana RPC and independently verify it. Never accept client-supplied amount, source, destination, mint, token-account owner, slot, confirmation state, or balance deltas as settlement evidence.

Only a business owner/admin session may submit or reconcile a funding leg. An agent API key may prepare and read an intent, but must not be able to assert that a business wallet has signed or paid. The admin route must use the existing business-scoped session and origin checks.

## Proposed API

- `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/submit`
  - Body: `{ "signature": "<base58 transaction signature>" }`
  - Resolve the intent, operation, leg, business, registered wallets, and active reservation from D1. Verify the leg belongs to the intent and business.
  - Accept only a leg in `awaiting_signature` (or a deliberately approved `authorized_for_execution` state). Reject expired intents and duplicate signatures.
  - Validate signature encoding/length and bind it immutably to the leg. Move the leg and intent to submitted in one D1 batch. The unique transaction-hash index prevents reuse by another leg.
  - Return pending; do not mark the leg confirmed merely because a signature was supplied.

- `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/reconcile`
  - No transaction data is accepted from the client. The Worker retrieves the signature stored on the leg.
  - Query `getSignatureStatuses` with history enabled. Treat missing, processed, or confirmed-but-not-finalized results as pending.
  - Query `getTransaction` with `commitment: finalized`, `encoding: jsonParsed`, and `maxSupportedTransactionVersion: 0`.
  - Verify RPC result signature, successful metadata, positive slot, registered source signer, exact SPL-token program instruction, source/destination token-account ownership, mint, decimals, exact atom amount, and matching pre/post token balance deltas using `verifySolanaTokenTransfer`.
  - If the RPC is unavailable or the finalized transaction is not yet indexed, return pending/502 without mutating ledger state.
  - If the finalized transaction is definitively failed or mismatched, record a safe failure/ambiguous result according to whether the chain outcome is definitive. Never release a reservation on an RPC timeout.

## Funding-leg-specific checks

### Reserve replenishment

- Source must be the leg's registered, active, ownership-verified reserve/operating wallet.
- Destination must be the business's registered payment wallet.
- The asset mint must be the configured USDC mint.
- The exact transfer amount must match the reserved leg amount. Do not accept overpayment or underpayment as a successful exact leg.
- After finality and verification, update the balance snapshot from a fresh RPC observation at a clearly recorded commitment, mark the leg confirmed, and consume/reconcile only that leg's source reservation exactly once.
- Only when every reserve-replenishment/conversion leg for the operation is confirmed and the payment wallet has sufficient fresh, confirmed USDC may the final-payment leg be reserved and advanced to `awaiting_signature`.

### Final payment

- Source must be the registered payment wallet and destination must equal the immutable intent destination.
- Mint and amount must equal the intent's immutable mint and payment amount.
- The recipient token account owner must equal the immutable destination address.
- Confirm the intent only after the final-payment transaction is finalized and the same strict transfer verifier succeeds.
- Consume the final-payment reservation once; keep the separate SOL network-fee reservation separate and reconcile it against actual fee-payer debit.

### Conversion

Conversion is explicitly out of scope for this endpoint. The existing SOL-debit verifier does not prove the complete swap route, program allowlist, output mint/recipient, or minimum output. Conversion needs a separate verifier that proves both source SOL debit and USDC output, validates approved programs/instructions and slippage, and reconciles the payment wallet's output. Do not treat a successful SOL debit as a successful conversion.

## Atomic D1 reconciliation

After RPC verification succeeds, perform all database state changes in one D1 batch with conditional predicates:

1. Claim the leg only if its stored signature matches and status is `submitted` (or a specifically supported `ambiguous` retry).
2. Store confirmed slot and verified received atoms.
3. Transition the leg to confirmed.
4. Consume/release only reservations linked to that funding leg, with exactly-once conditional updates.
5. For reserve replenishment, after all required funding legs are confirmed, reserve the final-payment leg and insert its managed reservation in the same batch. The existing database trigger remains a second line of defence.
6. Update intent and operation status only when all required conditions hold.

If any conditional statement changes zero rows, treat it as a concurrency/state conflict and do not return success. D1 batch atomicity must ensure partial state changes roll back together. Add a retry test proving that repeated reconciliation cannot consume a reservation twice or create duplicate final-payment holds.

## Balance observations

The existing `syncSolanaBalances` helper uses `confirmed` commitment for general dashboard balance refresh. It is not sufficient as settlement proof. Settlement must use finalized transaction evidence and must record the commitment/time of any refreshed balance snapshot. Never reset `reserved_atoms` while refreshing `confirmed_atoms`.

## Required tests before wiring production routes

- Wrong business, wrong leg, wrong wallet role, disabled/unverified wallet, expired intent, and non-owner session are rejected.
- Signature reuse across two legs is rejected.
- Processed/confirmed-but-not-finalized, missing transaction, RPC timeout, failed transaction, malformed jsonParsed metadata, unsupported transaction version, wrong signer, wrong token account owner, wrong mint/decimals, wrong amount, extra transfer, and unapproved instruction are rejected or remain pending without releasing holds.
- Exact finalized reserve transfer confirms once and consumes only its linked reservation.
- Multiple reserve legs must all confirm before the final-payment reservation exists.
- A failed reserve leg cannot unlock final payment.
- Exact finalized final payment confirms intent once and reconciles the final-payment and fee holds separately.
- Concurrent duplicate reconcile requests cannot double-consume or double-reserve.
- Conversion cannot pass through the SPL-transfer endpoint.
- Test on local D1 and Solana devnet/test fixtures before any mainnet wallet testing.

## Explicit non-goals

This stage must not create or hold private keys, sign transactions, broadcast transactions, auto-approve conversion, or move funds. Wallet construction/signing UX and Telegram Mini App handoff are separate stages.