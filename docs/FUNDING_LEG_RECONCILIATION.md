# Funding-Leg Submission and Reconciliation

## Status

Partially implemented on the draft feature branch. Owner/admin-only signature submission and finalized-RPC reconciliation are wired for simple SPL-token reserve-replenishment and final-payment legs. Final-payment readiness now requires all reserve legs to be confirmed, a fresh finalized USDC balance read from Solana RPC, and an atomic D1 transition that releases the preposition hold and creates the final-payment reservation. The actual transaction is still signed and broadcast by the business-controlled wallet. Conversion remains unsupported by this verifier. Nothing enables autonomous execution.

## Trust boundary

A client-supplied transaction signature is an untrusted lookup key, not proof of payment. The Worker must retrieve transaction data from the configured Solana RPC and independently verify it. Never accept client-supplied amount, source, destination, mint, token-account owner, slot, confirmation state, or balance deltas as settlement evidence.

Only a business owner/admin session may submit or reconcile a funding leg. An agent API key may prepare and read an intent, but must not be able to assert that a business wallet has signed or paid. The admin route must use the existing business-scoped session and origin checks.

## Implemented API

- `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/submit`
  - Body: `{ "signature": "<base58 transaction signature>" }`
  - Resolve the intent, operation, leg, business, registered wallets, and active reservation from D1. Verify the leg belongs to the intent and business.
  - Accepts reserved, `awaiting_signature`, or deliberately approved `authorized_for_execution` legs with an active linked reservation. A reserved leg is advanced through `awaiting_signature` before the submitted transition. Expired intents and duplicate signatures are rejected.
  - Validate signature encoding/length and bind it immutably to the leg. Move the leg and intent to submitted in one D1 batch. The unique transaction-hash index prevents reuse by another leg.
  - Return pending; do not mark the leg confirmed merely because a signature was supplied.

- `POST /v1/admin/payment-intents/:intentId/funding-legs/:legId/reconcile`
  - No transaction data is accepted from the client. The Worker retrieves the signature stored on the leg.
  - Queries `getSignatureStatuses` with history enabled. Missing, processed, and confirmed-but-not-finalized results remain pending.
  - Query `getTransaction` with `commitment: finalized`, `encoding: jsonParsed`, and `maxSupportedTransactionVersion: 1`.
  - Verify RPC result signature, successful metadata, positive slot, registered source signer, exact SPL-token program instruction, source/destination token-account ownership, mint, decimals, exact atom amount, and matching pre/post token balance deltas using `verifySolanaTokenTransfer`.
  - If the RPC is unavailable or the finalized transaction is not yet indexed, return pending/502 without mutating ledger state.
  - If the finalized transaction is definitively failed or mismatched, record a safe failure/ambiguous result according to whether the chain outcome is definitive. Never release a reservation on an RPC timeout.

## Funding-leg-specific checks

### Reserve replenishment

- Source must be the leg's registered, active, ownership-verified reserve/operating wallet.
- Destination must be the business's registered payment wallet.
- The asset mint must be the configured USDC mint.
- The exact transfer amount must match the reserved leg amount. Do not accept overpayment or underpayment as a successful exact leg.
- After finality and exact transfer verification, the leg is marked confirmed and only its linked source reservation is consumed.
- `POST /v1/admin/payment-intents/:intentId/prepare-final-payment?businessId=...` requires every reserve-replenishment leg to be confirmed, and the intent to remain unexpired. It reads every USDC token account for the registered payment wallet at `finalized` commitment and validates owner, mint, decimals and canonical atom amounts.
- In one D1 batch it advances the intent to `awaiting_signature`, updates the confirmed balance snapshot without resetting `reserved_atoms`, releases the operation's preposition hold, reserves the final-payment leg, and inserts the managed final-payment reservation. Database triggers independently enforce that the intent is ready and all replenishment legs are confirmed.
- RPC failure leaves the intent and reservations unchanged. If the finalized balance is insufficient, NERITH persists the finalized snapshot, releases only this operation's temporary preposition hold, and leaves the final-payment leg planned. Existing reservations and configured reserve floors remain protected.
- A partial unique index allows only one active managed reservation per funding leg. Repeated preparation after success returns the existing reservation; concurrent attempts cannot double-reserve.

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
5. For reserve replenishment, the separate final-payment preparation route requires all funding legs confirmed and a finalized balance read, then changes intent status, refreshes the balance snapshot, releases the preposition hold, reserves the final-payment leg and inserts its managed reservation in one D1 batch. Database triggers guard both the intent state and confirmed funding legs.
6. Update intent and operation status only when all required conditions hold.

If any conditional statement changes zero rows, treat it as a concurrency/state conflict and do not return success. D1 batch atomicity must ensure partial state changes roll back together. Add a retry test proving that repeated reconciliation cannot consume a reservation twice or create duplicate final-payment holds.

## Network-fee accounting release gate

**Aggregate per-transaction fee accounting is implemented on this draft branch, with production release still blocked.** Migration `0032_funding_leg_fee_ledger.sql` introduces an immutable aggregate fee budget and one fee-ledger row per non-conversion funding leg. The per-transaction policy cap remains separate from the aggregate hold.

- The plan reserves a checked aggregate SOL budget for every reserve-replenishment leg plus the final-payment leg before any signature is requested.
- Each fee row binds the operation, funding leg, verified fee-payer wallet and per-transaction maximum. The database guards identity, transaction signature, status transitions, finalized fee evidence and reconciliation immutability.
- Submission binds the ledger row to the same transaction signature as its funding leg. Reconciliation verifies the finalized transaction's first account key is the registered fee payer and that the parsed RPC account-key metadata explicitly marks that fee payer as a signer; it also verifies actual `meta.fee`, including finalized failed transactions. The source-token owner must separately appear as a required signer and be verified by the transfer verifier.
- Actual fees are reconciled per leg and cumulatively against the aggregate budget. The aggregate fee hold is retained while any row is reserved, submitted or ambiguous; only terminal rows permit unused budget release.
- A finalized failed reserve transfer still records its actual network fee even though its USDC transfer failed.
- Pre-migration submitted/replenishing intents with submitted legs lacking ledger rows are marked ambiguous during migration. Their existing holds are deliberately preserved for manual reconciliation rather than inventing fee evidence.
- Conversion remains excluded until its separate transaction/fee accounting and swap settlement verifier exist.

An earlier candidate commit passed typecheck, unit tests, Wrangler dry-run, the unpaid Hermes 402 evidence check, and the isolated local Worker/D1 integration suite. The current branch also opts into Solana transaction version 1 when reading finalized settlement and x402 transactions; this avoids a v0-only RPC ceiling on a network where v1 transactions are active. The newest CI run is validating this change. These checks validate the candidate implementation, not a funded-wallet transaction or a live paid x402 swap. Do not enable real signing, merge, or deploy until the current head passes CI and the remaining database failure/replay cases and wallet handoff tests are complete.

## Balance observations

The existing `syncSolanaBalances` helper uses `confirmed` commitment for general dashboard balance refresh. It is not sufficient as settlement proof. The final-payment preparation route uses a separate finalized token-account lookup, records the balance snapshot with `solana_rpc_finalized`, and never resets `reserved_atoms` while refreshing `confirmed_atoms`.

## Remaining tests before production readiness

- Wrong business, wrong leg, wrong wallet role, disabled/unverified wallet, expired intent, and non-owner session are rejected.
- Signature reuse across two legs is rejected.
- Processed/confirmed-but-not-finalized, missing transaction, RPC timeout, failed transaction, malformed jsonParsed metadata, unsupported transaction version, wrong signer, wrong token account owner, wrong mint/decimals, wrong amount, extra transfer, and unapproved instruction are rejected or remain pending without releasing holds.
- Exact finalized reserve transfer confirms once and consumes only its linked reservation.
- Multiple reserve legs must all confirm before the final-payment reservation exists.
- Finalized balance lookup aggregates multiple USDC token accounts and rejects mismatched owner, mint, decimals, malformed amounts and RPC errors.
- Replenishment final-payment database triggers reject an early intent transition, final-leg reservation or managed reservation before the intent is `awaiting_signature`.
- A failed reserve leg cannot unlock final payment.
- Exact finalized final payment confirms intent once and reconciles the final-payment and fee holds separately.
- Concurrent duplicate reconcile requests cannot double-consume or double-reserve.
- Conversion cannot pass through the SPL-transfer endpoint.
- Test on local D1 and Solana devnet/test fixtures before any mainnet wallet testing.

## Explicit non-goals

This stage must not create or hold private keys, sign transactions, broadcast transactions, auto-approve conversion, or move funds. Wallet construction/signing UX and Telegram Mini App handoff are separate stages.

## Route behavior currently implemented

- All three settlement/preparation routes require a business-scoped owner/admin session, same-origin/allowlisted browser origin on writes, and a `businessId` query parameter. The expiry worker also preserves holds while any funding leg is submitted or ambiguous. The intent and leg are resolved together from D1, so a leg cannot be submitted under another business scope.
- The submit body accepts only a base58 transaction signature. It does not accept transaction facts or a client-declared settlement state.
- Reconciliation uses the stored signature and the configured HTTPS RPC. Exact finalized transfers consume only the linked reservation. Finalized mismatches become `ambiguous` and retain their hold; the scheduled expiry routine skips ambiguous intents.
- Reserve-replenishment confirmation does not itself credit a cached payment-wallet balance. The separate prepare-final-payment route performs a finalized RPC balance refresh and atomically creates the final hold; repeated calls reuse the existing hold. The separate fee reservation is reconciled only after the finalized transaction identifies the registered business fee payer and proves the actual network fee is within the approved cap; the fee wallet must remain active, verified, business-scoped and assigned.
- These routes are code on a draft PR only. They have not been deployed or exercised against a funded wallet.
