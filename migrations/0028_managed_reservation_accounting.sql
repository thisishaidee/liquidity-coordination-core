-- Distinguish legacy application-managed reservations from trigger-managed
-- multi-wallet reservations. Existing paths retain their manual accounting.
ALTER TABLE reservations
ADD COLUMN reservation_source TEXT NOT NULL DEFAULT 'legacy'
CHECK (reservation_source IN ('legacy', 'managed'));

-- Managed reservations update the aggregate balance inside the same D1 batch
-- that inserts the reservation row. Any insufficient leg aborts the statement
-- and the enclosing batch, preventing partial multi-wallet reservations.
CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_reserve_balance
BEFORE INSERT ON reservations
WHEN NEW.reservation_source = 'managed' AND NEW.status = 'active'
BEGIN
  UPDATE wallet_balances
  SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + CAST(NEW.amount_atoms AS INTEGER)
  WHERE id = NEW.wallet_balance_id
    AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= CAST(NEW.amount_atoms AS INTEGER);
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'managed_reservation_insufficient_balance')
  END;
END;

-- A managed reservation releases its aggregate hold exactly once when its
-- status leaves active. A mismatch aborts the state change.
CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_release_balance
AFTER UPDATE OF status ON reservations
WHEN OLD.reservation_source = 'managed'
  AND OLD.status = 'active'
  AND NEW.status IN ('released', 'consumed', 'expired')
BEGIN
  UPDATE wallet_balances
  SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - CAST(OLD.amount_atoms AS INTEGER)
  WHERE id = OLD.wallet_balance_id
    AND CAST(reserved_atoms AS INTEGER) >= CAST(OLD.amount_atoms AS INTEGER);
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'managed_reservation_ledger_mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_identity_immutable
BEFORE UPDATE OF wallet_balance_id, amount_atoms, reservation_source, funding_leg_id ON reservations
WHEN OLD.reservation_source = 'managed' AND OLD.status = 'active'
  AND (
    NEW.wallet_balance_id IS NOT OLD.wallet_balance_id
    OR NEW.amount_atoms IS NOT OLD.amount_atoms
    OR NEW.reservation_source IS NOT OLD.reservation_source
    OR NEW.funding_leg_id IS NOT OLD.funding_leg_id
  )
BEGIN
  SELECT RAISE(ABORT, 'managed_reservation_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_active_delete_block
BEFORE DELETE ON reservations
WHEN OLD.reservation_source = 'managed' AND OLD.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'managed_reservation_must_be_released_before_delete');
END;
