# NERITH atomic reservation and multi-leg payment design

## Current reservation system audit

The existing product already has a reservation ledger:

- The reservations table stores operation ID, wallet-balance ID, amount, token, status and expiry.
- A direct liquidity request currently reserves one wallet-balance row and then creates one operation plus one reservation.
- A conversion operation can have a source reservation and a target USDC reservation. The operations table has single source/target reservation references and one transaction hash for its conversion flow.
- Release and completion paths iterate all active reservation rows for an operation, so the reservation table itself can represent multiple rows.
- The scheduled expireReservations routine reconciles wallet_balances.reserved_atoms from active reservation rows and repairs terminal operations whose Worker invocation stopped partway through processing.
- Existing idempotency is scoped to UNIQUE(agent_id, task_id). It is not a business-wide payment-intent idempotency key.
- The current agent liquidity-request path selects wallets by legacy purpose = operating and the agent's can_use_business_treasury permission. It does not yet consume the new payment/reserve role model or the new wallet ownership proof.
- Agent-reported completion of a direct operation is not proof of an on-chain payment. Conversion status has a separate signature/settlement verification path.

These legacy paths must remain compatible. The new business payment flow should not silently change their meaning.

## Why multi-wallet payments need a separate model

A replenishment plan can contain multiple source wallets. Each source-to-payment-wallet transfer is a distinct on-chain action unless all required signers and instructions are deliberately combined into one transaction. The final payment is another action after replenishment is confirmed.

A single operations.transaction_hash or source_reservation_id cannot faithfully represent several independently submitted and confirmed funding legs. A single status flag cannot describe partial success across multiple source wallets.

## Proposed data model

### business_payment_intents

One row per business payment request:

- intent ID and business ID
- optional initiating agent ID and source task reference
- business-unique idempotency key
- destination address and asset mint
- requested amount and policy-approved amount
- policy snapshot/version used for the decision
- status, expiry and timestamps
- unique constraint on (business_id, idempotency_key)

The idempotency key must be checked and inserted in the same D1 transaction that creates the intent. A repeated key returns the existing intent; it must never create a second payment.

### operation_funding_legs (draft schema added)

The draft migration now adds one row per independently tracked on-chain action:

- intent ID and deterministic sequence number
- leg kind: reserve_replenishment, conversion, or final_payment
- source wallet, destination wallet and mint
- planned amount and expected output where relevant
- status: planned, reserved, awaiting_signature, submitted, confirmed, failed, expired or ambiguous
- transaction signature, submitted slot, confirmed slot and observed amount
- failure/reconciliation reason and timestamps

A reserve-replenishment plan with three source wallets creates three transfer legs. The final payment is not submitted until every required replenishment leg has reached confirmed state and the payment-wallet balance has been independently refreshed.

### Reservation ledger

The draft adds a nullable funding_leg_id link and a reservation_source discriminator to the existing reservations table. Legacy rows remain on the existing manual accounting path. New rows marked managed are reserved and released by database triggers, which conditionally update wallet_balances and abort when the balance ledger cannot satisfy the request. The release/complete handlers distinguish managed rows so they do not double-debit them. No endpoint currently creates managed rows, so the existing production flow remains unchanged. Do not duplicate the existing reservation ledger without a clear ownership boundary. Two implementation choices need a short prototype:

1. Extend reservations with a nullable business_payment_intent_id / leg_id and a clear reservation_kind, preserving operation_id for the existing agent flow.
2. Add a dedicated business_payment_reservations table linked to payment intent legs.

For the new business flow, reservation insertion should be the source of truth and should update wallet_balances.reserved_atoms through database triggers. A BEFORE INSERT trigger should conditionally increment the aggregate only when confirmed minus reserved is sufficient, then abort the statement if the update did not affect exactly one balance row. D1 batch insertion of all legs then becomes all-or-nothing: if any source cannot be reserved, the transaction rolls back all reservation rows and aggregate updates.

Reservation amounts and wallet-balance IDs must be immutable after creation. State transitions from active to released/consumed/expired should decrement the aggregate exactly once. Duplicate release or consume attempts must be harmless and idempotent.

The existing reservations table currently relies on application-side balance updates and reconciliation. Do not add triggers to it without first removing or carefully separating the existing manual updates; otherwise balances could be reserved twice.

## Atomic reservation sequence

1. Validate the request and business policy.
2. Load fresh, verified payment and reserve wallet snapshots.
3. Evaluate the deterministic policy and construct the exact funding legs.
4. Insert the payment intent with its unique business idempotency key.
5. Insert every leg and its reservation rows in one D1 batch.
6. Let reservation triggers conditionally update each wallet balance. If any leg fails, abort the batch so no partial internal reservation is left behind.
7. Return the prepared intent and funding plan. No transaction is signed or broadcast at this stage.

Do not hold reservations indefinitely. Every reservation must have a bounded expiry. A scheduled reconciler should release expired reservations only when the corresponding operation state permits it, and should compare the reservation ledger with wallet_balances.reserved_atoms.

## Multi-leg execution state machine

draft → policy_checked → reserved → awaiting_signature / authorized_for_execution → submitted → confirmed / failed / expired / ambiguous

For multiple replenishment legs, the intent remains in replenishing until all required legs are confirmed. A failed leg must not cause NERITH to claim the full amount was replenished. If some transfers already confirmed, those funds remain in the payment wallet and must be shown accurately; there is no implied cross-transaction atomicity.

Only after confirmed replenishment and a fresh balance observation can the final-payment leg be prepared. Final payment confirmation must be verified from the transaction signature and expected token-account balance changes, not an agent's self-reported completion.

## Required tests before implementation is considered complete

- Two or more source wallets reserve successfully in one atomic batch.
- If any one source lacks spendable balance, no source reservation or aggregate reserved amount changes.
- Duplicate idempotency key returns the same intent and never double-reserves.
- Concurrent requests cannot reserve the same atoms twice.
- Release, expiry and consume transitions decrement reserved amounts exactly once.
- A crash between intent creation and signature submission is recoverable.
- One confirmed replenishment leg plus one failed leg is reported as partial funding, not success.
- Final payment cannot be submitted before all required replenishment legs confirm.
- A stale or unverified wallet cannot be reserved.
- API-payment wallets, receiving wallets and agent-scoped wallets cannot be treated as business reserve sources unless a separately approved policy explicitly allows them.

## Implementation boundary

The draft now includes the per-leg table, reservation link, immutable identity/hash guards and state-transition triggers. The current policy evaluator is not wired into createLiquidityRequest or a business payment endpoint, and no code creates or advances these new legs. Atomic multi-wallet reservation, business payment intents, transaction submission and fund movement remain unimplemented.
