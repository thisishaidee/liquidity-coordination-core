# NERITH payment preparation, atomic reservations and multi-leg execution

## Legacy reservation system

The existing V1 liquidity-request flow remains separate and unchanged:

- A direct liquidity request reserves one wallet-balance row and creates one operation plus one reservation.
- A legacy conversion operation can have a source reservation and a target USDC reservation. Its operation row has one transaction hash and source/target reservation references.
- Legacy reservations use application-side aggregate accounting.
- Agent-reported completion of a legacy direct operation is not proof that an external on-chain payment occurred. Conversion status has a separate transaction verification path.

The new business payment-intent flow uses a distinct managed reservation mode. Do not reinterpret legacy operation statuses or reservation semantics.

## Implemented branch candidate

### Business payment intent

Migration `0030_business_payment_intents.sql` adds:

- `business_payment_policies`: per-business asset and destination allowlists, fee-payer allowlist, transaction/daily limits, balance freshness, intent lifetime, slippage and conversion/partial-payment flags.
- `business_payment_intents`: one immutable payment request per business idempotency key, linked to one existing operation row.
- Unique `(business_id, idempotency_key)` constraint.
- Immutable intent identity and guarded lifecycle transitions.
- Database insert guards that re-check the policy version, mint/destination/fee-payer allowlists, per-transaction limit and daily aggregate cap.

The payment intent is linked to its funding legs through `operation_id`; the funding-leg table does not directly reference the intent.

### Funding legs

Migration `0027_operation_funding_legs.sql` adds `operation_funding_legs`, with one row per independently tracked on-chain action:

- `reserve_replenishment`, `conversion`, or `final_payment`
- Source and destination wallet IDs, destination address, asset mint and amount
- Expected/received output atoms
- Guarded states from planned/reserved through signature, submission and confirmation or failure
- Transaction signature, submitted/confirmed slots and failure reason
- Immutable leg identity, immutable transaction hash after first assignment, and a unique transaction-hash index to prevent one signature being reused across legs

### Managed reservation accounting

Migration `0028_managed_reservation_accounting.sql` adds managed reservation accounting while preserving legacy rows:

- `managed` rows reserve USDC against a funding leg.
- `managed_fee` rows reserve SOL network fees against the payment intent's approved fee-payer wallet.
- D1 triggers verify business scope, verified address control, active wallet, enabled role, permitted leg kind, reserve floor, transfer cap and available balance.
- A failed insert aborts the D1 batch; earlier reservation rows and balance updates are rolled back.
- Leaving active for released, consumed or expired decrements the aggregate exactly once.
- Managed reservation identity cannot be mutated, and active managed rows cannot be deleted.
- Release, completion and expiry code skips manual aggregate debits for trigger-managed rows to avoid double-decrementing.

Migration `0029_final_payment_funding_gate.sql` prevents a final-payment leg from being reserved or advanced to signature/submission while any reserve-replenishment or conversion leg remains unconfirmed.

### API flow

The draft branch wires the foundation into:

- `POST /v1/payments/prepare`: agent-authenticated, requires explicit business-treasury permission, validates the Solana destination public key, checks the deterministic payment policy, enforces idempotency, then inserts the intent, operation, funding legs and USDC/SOL reservations in one D1 batch.
- `GET /v1/payments/:intentId`: returns intent state, funding-leg details and reservation state to the initiating agent only.
- Existing `POST /v1/operations/:id/release` cancels the payment intent and releases its active managed holds.
- Existing agent completion is blocked for business payment intents. An agent cannot self-report an on-chain payment as complete.
- Reservation expiry also moves eligible payment intents to expired and releases holds.

The deterministic policy evaluator checks business scope, verified/fresh payment and reserve wallets, mint/destination allowlists, transaction and daily caps, reserve floors, per-transfer limits, fee-payer policy, network-fee caps, conversion-source allowlists, slippage and explicit partial-payment permission. A separate pure module, `src/payment-settlement.ts`, now verifies a parsed finalized SPL-token transfer against the expected funding leg: submitted signature, source-wallet signer, source/destination token-account owners, mint, exact amount and both token-balance deltas. It rejects extra top-level value-moving instructions and unapproved inner instructions. This verifier is unit-tested but is not yet connected to an RPC reconciliation endpoint. The database re-checks mutable policy constraints when inserting the intent so concurrent requests cannot both consume the same daily allowance based only on a stale application read.

All of the above remains branch-only. No production migration or deployment has occurred.

## Atomic reservation sequence

1. Authenticate the agent and require its explicit business-treasury permission.
2. Validate request shape, Solana destination key, idempotency key and amount.
3. Load the current business payment policy and fresh verified wallet snapshots.
4. Evaluate the deterministic policy and build a funding plan.
5. Insert the operation and immutable business payment intent.
6. Insert all funding legs and managed USDC/SOL reservations in the same D1 batch.
7. Let D1 triggers enforce each reservation and policy constraint. If any insert fails, the batch must leave no partial intent, leg, reservation or aggregate update.
8. Return the prepared funding plan. No transaction is built, signed or broadcast at this stage.

A reserve-replenishment plan with multiple source wallets creates one distinct leg and reservation per source. The final-payment leg remains planned until every required funding leg is confirmed. Cross-transaction replenishment is not atomic on-chain: if one transfer succeeds and another fails, already received funds remain in the payment wallet and must be reported accurately.

## Still required before fund movement

- Build exact SPL Token / Token-2022 transfer instructions from verified source token accounts to the approved destination token account.
- Resolve and validate associated token accounts, token program IDs, decimals and mint ownership; do not treat an arbitrary base58 key as proof of a valid token account.
- Create an unsigned transaction for owner review and wallet signing. The browser must not hold or expose agent API keys or private keys.
- Wire the pure SPL-token transfer verifier into authenticated transaction-submission and reconciliation endpoints. Verify finalized transaction metadata against expected signer, source account, destination account, mint, amount and operation/leg before changing a leg to confirmed.
- Refresh destination wallet balances from Solana RPC after each confirmed replenishment before preparing final payment.
- Add a tested manual owner-signing fallback first; real Android OKX, Phantom, Solflare and Backpack handoff must be tested before claiming support.
- Implement the Telegram Mini App review/handoff only after validating Telegram `initData`, scoped sessions, roles, replay protection and operation-bound approvals.
- Keep autonomous signing disabled until a separately reviewed Squads or customer-controlled KMS/MPC authority, revocation path, recovery plan and threat model are implemented.

## Validation status

- [x] Managed reservation across two verified reserve wallets.
- [x] Cross-wallet insufficient-balance failure rolls back all rows and aggregate updates.
- [x] Reserve floor and per-transfer cap are enforced.
- [x] Direct payment intent preparation and idempotent replay.
- [x] Changed payload under the same idempotency key is rejected.
- [x] Invalid Solana destination is rejected.
- [x] SOL network-fee hold is separate from USDC payment liquidity.
- [x] Payment intent release cancels the intent and releases USDC and SOL holds.
- [x] Agent-reported completion is blocked for a business payment intent.
- [x] Agent-scoped payment detail returns funding legs and reservations.
- [x] Final-payment leg remains blocked until all replenishment legs confirm.
- [x] Database policy insert guard checks allowlists and daily limits.
- [ ] Concurrent request stress test for overlapping source-wallet reservations.
- [ ] Expiry integration test for mixed managed USDC and managed-fee SOL reservations.
- [x] Pure SPL-token transfer verifier tests: exact signature, signer, recipient, mint, amount, source/destination balance deltas, duplicate transfers and unapproved programs.
- [ ] On-chain funding-leg submission and reconciliation tests.
- [ ] Real wallet transaction-signing and Android handoff tests.

## Execution boundary

Payment preparation and reservation are not payment execution. No direct transfer transaction builder, signature collection, broadcast, on-chain replenishment verifier, final-payment verifier, Squads integration or KMS/MPC signer is implemented in this branch. Do not mark a payment confirmed based on an agent callback or a transaction hash supplied without RPC verification.
