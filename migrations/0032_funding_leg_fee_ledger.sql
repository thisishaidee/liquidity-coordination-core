-- Per-funding-leg network-fee accounting.
-- network_fee_lamports remains the approved maximum for each transaction;
-- network_fee_budget_lamports is the aggregate hold across every planned leg.
ALTER TABLE business_payment_intents
  ADD COLUMN network_fee_budget_lamports TEXT NOT NULL DEFAULT '0'
  CHECK (
    network_fee_budget_lamports GLOB '[0-9]*'
    AND network_fee_budget_lamports NOT GLOB '*[^0-9]*'
    AND length(network_fee_budget_lamports) BETWEEN 1 AND 19
    AND (length(network_fee_budget_lamports) < 19 OR network_fee_budget_lamports <= '9223372036854775807')
  );

UPDATE business_payment_intents
SET network_fee_budget_lamports = network_fee_lamports
WHERE network_fee_budget_lamports = '0'
  AND network_fee_lamports <> '0';

CREATE TABLE IF NOT EXISTS operation_funding_leg_fees (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  funding_leg_id TEXT NOT NULL UNIQUE REFERENCES operation_funding_legs(id) ON DELETE CASCADE,
  fee_payer_wallet_id TEXT NOT NULL REFERENCES wallets(id),
  maximum_fee_lamports TEXT NOT NULL,
  actual_fee_lamports TEXT,
  transaction_hash TEXT,
  finalized_slot INTEGER,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'submitted', 'reconciled', 'ambiguous', 'not_required')),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    maximum_fee_lamports GLOB '[0-9]*'
    AND maximum_fee_lamports NOT GLOB '*[^0-9]*'
    AND length(maximum_fee_lamports) BETWEEN 1 AND 19
    AND (length(maximum_fee_lamports) < 19 OR maximum_fee_lamports <= '9223372036854775807')
  ),
  CHECK (
    actual_fee_lamports IS NULL OR (
      actual_fee_lamports GLOB '[0-9]*'
      AND actual_fee_lamports NOT GLOB '*[^0-9]*'
      AND length(actual_fee_lamports) BETWEEN 1 AND 19
      AND (length(actual_fee_lamports) < 19 OR actual_fee_lamports <= '9223372036854775807')
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_funding_leg_fees_operation_status
  ON operation_funding_leg_fees(operation_id, status);

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_insert_requires_reserved
BEFORE INSERT ON operation_funding_leg_fees
WHEN NEW.status <> 'reserved'
  OR NEW.actual_fee_lamports IS NOT NULL
  OR NEW.transaction_hash IS NOT NULL
  OR NEW.finalized_slot IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_fee_insert_must_be_unsubmitted');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_identity_immutable
BEFORE UPDATE OF operation_id, funding_leg_id, fee_payer_wallet_id, maximum_fee_lamports, created_at
ON operation_funding_leg_fees
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.funding_leg_id IS NOT OLD.funding_leg_id
  OR NEW.fee_payer_wallet_id IS NOT OLD.fee_payer_wallet_id
  OR NEW.maximum_fee_lamports IS NOT OLD.maximum_fee_lamports
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_fee_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_transaction_immutable
BEFORE UPDATE OF transaction_hash ON operation_funding_leg_fees
WHEN OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash IS NOT OLD.transaction_hash
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_fee_transaction_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_state_transition
BEFORE UPDATE OF status ON operation_funding_leg_fees
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'reserved' AND NEW.status IN ('submitted', 'not_required'))
  OR (OLD.status = 'submitted' AND NEW.status IN ('reconciled', 'ambiguous'))
  OR (OLD.status = 'ambiguous' AND NEW.status = 'reconciled')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_funding_leg_fee_transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_submitted_requires_signature
BEFORE UPDATE OF status ON operation_funding_leg_fees
WHEN NEW.status = 'submitted'
  AND (NEW.transaction_hash IS NULL OR length(NEW.transaction_hash) = 0)
BEGIN
  SELECT RAISE(ABORT, 'submitted_funding_leg_fee_requires_signature');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_reconciled_requires_finalized_fee
BEFORE UPDATE OF status ON operation_funding_leg_fees
WHEN NEW.status = 'reconciled'
  AND (
    NEW.transaction_hash IS NULL OR
    NEW.actual_fee_lamports IS NULL OR
    NEW.finalized_slot IS NULL OR NEW.finalized_slot <= 0
  )
BEGIN
  SELECT RAISE(ABORT, 'reconciled_funding_leg_fee_requires_finalized_fee');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_reconciliation_immutable
BEFORE UPDATE OF actual_fee_lamports, finalized_slot ON operation_funding_leg_fees
WHEN OLD.status = 'reconciled'
  AND (
    NEW.actual_fee_lamports IS NOT OLD.actual_fee_lamports
    OR NEW.finalized_slot IS NOT OLD.finalized_slot
  )
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_fee_reconciliation_immutable');
END;

-- The single managed_fee reservation is the aggregate budget for all
-- transaction legs. It is released only by the application after all fee rows
-- have reached a terminal, reconciled/not-required state.
DROP TRIGGER IF EXISTS trg_managed_fee_reservation_reserve_balance;
CREATE TRIGGER trg_managed_fee_reservation_reserve_balance
BEFORE INSERT ON reservations
WHEN NEW.reservation_source = 'managed_fee' AND NEW.status = 'active'
BEGIN
  SELECT CASE WHEN NEW.amount_atoms IS NULL
    OR NEW.amount_atoms = ''
    OR NEW.amount_atoms GLOB '*[^0-9]*'
    OR substr(NEW.amount_atoms, 1, 1) = '0'
    OR length(NEW.amount_atoms) > 19
    OR (length(NEW.amount_atoms) = 19 AND NEW.amount_atoms > '9223372036854775807')
    THEN RAISE(ABORT, 'managed_fee_reservation_amount_invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM wallet_balances b
    JOIN wallets fee_wallet ON fee_wallet.id = b.wallet_id
    JOIN operations op ON op.id = NEW.operation_id
    JOIN business_payment_intents payment_intent
      ON payment_intent.operation_id = op.id
      AND payment_intent.fee_payer_wallet_id = fee_wallet.id
      AND payment_intent.network_fee_budget_lamports = NEW.amount_atoms
      AND payment_intent.action <> 'conversion_required'
    WHERE b.id = NEW.wallet_balance_id
      AND b.token = 'SOL'
      AND fee_wallet.business_id = op.business_id
      AND fee_wallet.scope = 'business'
      AND fee_wallet.status = 'active'
      AND fee_wallet.ownership_verified_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM wallet_role_assignments fee_role
        WHERE fee_role.business_id = fee_wallet.business_id
          AND fee_role.wallet_id = fee_wallet.id
          AND fee_role.enabled = 1
          AND fee_role.role IN ('payment', 'operating')
      )
  ) THEN RAISE(ABORT, 'managed_fee_wallet_not_authorized') END;

  UPDATE wallet_balances
  SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + CAST(NEW.amount_atoms AS INTEGER)
  WHERE id = NEW.wallet_balance_id
    AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= CAST(NEW.amount_atoms AS INTEGER)
    AND CAST(reserved_atoms AS INTEGER) <= 9223372036854775807 - CAST(NEW.amount_atoms AS INTEGER);
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'managed_fee_reservation_insufficient_balance')
  END;
END;

-- The aggregate budget is immutable after intent creation.
CREATE TRIGGER IF NOT EXISTS trg_business_payment_intent_fee_budget_immutable
BEFORE UPDATE OF network_fee_budget_lamports ON business_payment_intents
WHEN NEW.network_fee_budget_lamports IS NOT OLD.network_fee_budget_lamports
BEGIN
  SELECT RAISE(ABORT, 'business_payment_intent_fee_budget_immutable');
END;

-- Every non-conversion funding leg must have exactly one fee row tied to the
-- same operation, approved fee payer and per-transaction policy cap.
CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_scope_insert
BEFORE INSERT ON operation_funding_leg_fees
WHEN NOT EXISTS (
  SELECT 1
  FROM operation_funding_legs leg
  JOIN business_payment_intents intent ON intent.operation_id = leg.operation_id
  WHERE leg.id = NEW.funding_leg_id
    AND leg.operation_id = NEW.operation_id
    AND leg.kind IN ('reserve_replenishment', 'final_payment')
    AND leg.transaction_hash IS NULL
    AND intent.fee_payer_wallet_id = NEW.fee_payer_wallet_id
    AND intent.network_fee_lamports = NEW.maximum_fee_lamports
    AND intent.action <> 'conversion_required'
)
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_fee_scope_invalid');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_fee_state_matches_leg
BEFORE UPDATE OF status ON operation_funding_leg_fees
WHEN (
  NEW.status = 'submitted' AND NOT EXISTS (
    SELECT 1 FROM operation_funding_legs leg
    WHERE leg.id = NEW.funding_leg_id AND leg.operation_id = NEW.operation_id
      AND leg.status = 'submitted' AND leg.transaction_hash = NEW.transaction_hash
  )
) OR (
  NEW.status = 'reconciled' AND (
    CAST(NEW.actual_fee_lamports AS INTEGER) > CAST(NEW.maximum_fee_lamports AS INTEGER)
    OR NOT EXISTS (
      SELECT 1 FROM operation_funding_legs leg
      WHERE leg.id = NEW.funding_leg_id AND leg.operation_id = NEW.operation_id
        AND leg.status IN ('confirmed', 'failed', 'ambiguous')
        AND leg.transaction_hash = NEW.transaction_hash
    )
  )
) OR (
  NEW.status = 'ambiguous' AND NOT EXISTS (
    SELECT 1 FROM operation_funding_legs leg
    WHERE leg.id = NEW.funding_leg_id AND leg.operation_id = NEW.operation_id
      AND leg.status = 'ambiguous' AND leg.transaction_hash = NEW.transaction_hash
  )
) OR (
  NEW.status = 'not_required' AND NOT EXISTS (
    SELECT 1 FROM operation_funding_legs leg
    WHERE leg.id = NEW.funding_leg_id AND leg.operation_id = NEW.operation_id
      AND leg.status IN ('planned', 'reserved', 'awaiting_signature', 'authorized_for_execution', 'cancelled', 'expired')
      AND leg.transaction_hash IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_fee_state_mismatch');
END;


-- Existing intents may already have submitted transactions from before this
-- ledger existed. Do not fabricate fee records or release their existing
-- holds: mark the parent intent ambiguous so new release/reconciliation paths
-- cannot mistake an untracked in-flight transaction for a fully accounted one.
UPDATE business_payment_intents
SET status = 'ambiguous', updated_at = datetime('now')
WHERE status IN ('submitted', 'replenishing')
  AND EXISTS (
    SELECT 1 FROM operation_funding_legs leg
    WHERE leg.operation_id = business_payment_intents.operation_id
      AND leg.status = 'submitted'
      AND NOT EXISTS (
        SELECT 1 FROM operation_funding_leg_fees fee
        WHERE fee.funding_leg_id = leg.id
      )
  );
