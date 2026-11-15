-- Per-leg execution records for operations that require multiple transfers.
-- This is an additive ledger foundation; existing single-hash operation flows remain unchanged.
CREATE TABLE IF NOT EXISTS operation_funding_legs (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  leg_index INTEGER NOT NULL CHECK (leg_index >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('reserve_replenishment', 'conversion', 'final_payment')),
  source_wallet_id TEXT REFERENCES wallets(id),
  destination_wallet_id TEXT REFERENCES wallets(id),
  destination_address TEXT NOT NULL,
  asset_mint TEXT NOT NULL,
  amount_atoms TEXT NOT NULL,
  expected_output_atoms TEXT,
  received_output_atoms TEXT,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN (
    'planned', 'reserved', 'awaiting_signature', 'authorized_for_execution',
    'submitted', 'confirmed', 'failed', 'released', 'expired', 'ambiguous', 'cancelled'
  )),
  transaction_hash TEXT,
  submitted_slot INTEGER,
  confirmed_slot INTEGER,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(operation_id, leg_index)
);

ALTER TABLE reservations
ADD COLUMN funding_leg_id TEXT REFERENCES operation_funding_legs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_funding_legs_operation_order
  ON operation_funding_legs(operation_id, leg_index);
CREATE INDEX IF NOT EXISTS idx_funding_legs_status_updated
  ON operation_funding_legs(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_legs_transaction_hash
  ON operation_funding_legs(transaction_hash)
  WHERE transaction_hash IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_identity_immutable
BEFORE UPDATE OF operation_id, leg_index, kind, source_wallet_id,
                 destination_wallet_id, destination_address, asset_mint, amount_atoms
ON operation_funding_legs
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.leg_index IS NOT OLD.leg_index
  OR NEW.kind IS NOT OLD.kind
  OR NEW.source_wallet_id IS NOT OLD.source_wallet_id
  OR NEW.destination_wallet_id IS NOT OLD.destination_wallet_id
  OR NEW.destination_address IS NOT OLD.destination_address
  OR NEW.asset_mint IS NOT OLD.asset_mint
  OR NEW.amount_atoms IS NOT OLD.amount_atoms
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_transaction_hash_immutable
BEFORE UPDATE OF transaction_hash ON operation_funding_legs
WHEN OLD.transaction_hash IS NOT NULL AND NEW.transaction_hash <> OLD.transaction_hash
BEGIN
  SELECT RAISE(ABORT, 'funding_leg_transaction_hash_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_state_transition
BEFORE UPDATE OF status ON operation_funding_legs
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'planned' AND NEW.status IN ('reserved', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'reserved' AND NEW.status IN ('awaiting_signature', 'authorized_for_execution', 'failed', 'released', 'expired', 'cancelled'))
  OR (OLD.status = 'awaiting_signature' AND NEW.status IN ('submitted', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'authorized_for_execution' AND NEW.status IN ('submitted', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'ambiguous'))
  OR (OLD.status = 'ambiguous' AND NEW.status IN ('confirmed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_funding_leg_transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_submitted_requires_hash
BEFORE UPDATE OF status ON operation_funding_legs
WHEN NEW.status = 'submitted' AND (NEW.transaction_hash IS NULL OR length(NEW.transaction_hash) = 0)
BEGIN
  SELECT RAISE(ABORT, 'submitted_funding_leg_requires_transaction_hash');
END;

CREATE TRIGGER IF NOT EXISTS trg_funding_leg_confirmed_requires_hash
BEFORE UPDATE OF status ON operation_funding_legs
WHEN NEW.status = 'confirmed' AND (NEW.transaction_hash IS NULL OR length(NEW.transaction_hash) = 0)
BEGIN
  SELECT RAISE(ABORT, 'confirmed_funding_leg_requires_transaction_hash');
END;
