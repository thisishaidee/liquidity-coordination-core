-- Distinguish legacy application-managed reservations from trigger-managed
-- multi-wallet reservations. Existing paths retain their manual accounting.
ALTER TABLE reservations
ADD COLUMN reservation_source TEXT NOT NULL DEFAULT 'legacy'
CHECK (reservation_source IN ('legacy', 'managed', 'managed_fee'));

-- Managed reservations update the aggregate balance inside the same D1 batch
-- that inserts the reservation row. Any insufficient leg aborts the statement
-- and the enclosing batch, preventing partial multi-wallet reservations.
CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_reserve_balance
BEFORE INSERT ON reservations
WHEN NEW.reservation_source = 'managed' AND NEW.status = 'active'
BEGIN
  SELECT CASE WHEN NEW.amount_atoms IS NULL
    OR NEW.amount_atoms = ''
    OR NEW.amount_atoms GLOB '*[^0-9]*'
    OR substr(NEW.amount_atoms, 1, 1) = '0'
    OR length(NEW.amount_atoms) > 19
    OR (length(NEW.amount_atoms) = 19 AND NEW.amount_atoms > '9223372036854775807')
    THEN RAISE(ABORT, 'managed_reservation_amount_invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM wallet_balances b
    JOIN wallets source_wallet ON source_wallet.id = b.wallet_id
    JOIN operations op ON op.id = NEW.operation_id
    JOIN operation_funding_legs leg ON leg.id = NEW.funding_leg_id
      AND leg.operation_id = NEW.operation_id
    WHERE b.id = NEW.wallet_balance_id
      AND leg.source_wallet_id = source_wallet.id
      AND source_wallet.business_id = op.business_id
      AND source_wallet.scope = 'business'
      AND source_wallet.status = 'active'
      AND source_wallet.ownership_verified_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM wallet_role_assignments source_role
        WHERE source_role.business_id = source_wallet.business_id
          AND source_role.wallet_id = source_wallet.id
          AND source_role.enabled = 1
          AND (
            (leg.kind = 'final_payment' AND source_role.role = 'payment')
            OR (
              leg.kind IN ('reserve_replenishment', 'conversion')
              AND source_role.role IN ('reserve', 'operating')
              AND (
                source_role.role = 'reserve'
                OR NOT EXISTS (
                  SELECT 1 FROM wallet_role_assignments stricter_reserve
                  WHERE stricter_reserve.business_id = source_wallet.business_id
                    AND stricter_reserve.wallet_id = source_wallet.id
                    AND stricter_reserve.role = 'reserve'
                    AND stricter_reserve.enabled = 1
                )
              )
            )
          )
          AND CAST(NEW.amount_atoms AS INTEGER) <= COALESCE(CAST(source_role.maximum_transfer_atoms AS INTEGER), 9223372036854775807)
      )
      AND (
        leg.kind = 'final_payment'
        OR EXISTS (
          SELECT 1
          FROM wallets destination_wallet
          JOIN wallet_role_assignments destination_role
            ON destination_role.wallet_id = destination_wallet.id
            AND destination_role.business_id = destination_wallet.business_id
          WHERE destination_wallet.id = leg.destination_wallet_id
            AND destination_wallet.business_id = op.business_id
            AND destination_wallet.scope = 'business'
            AND destination_wallet.status = 'active'
            AND destination_wallet.ownership_verified_at IS NOT NULL
            AND destination_wallet.address = leg.destination_address
            AND destination_role.role = 'payment'
            AND destination_role.enabled = 1
        )
      )
  ) THEN RAISE(ABORT, 'managed_reservation_wallet_not_authorized') END;

  UPDATE wallet_balances
  SET reserved_atoms = CAST(reserved_atoms AS INTEGER) + CAST(NEW.amount_atoms AS INTEGER)
  WHERE id = NEW.wallet_balance_id
    AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) >= CAST(NEW.amount_atoms AS INTEGER)
    AND CAST(reserved_atoms AS INTEGER) <= 9223372036854775807 - CAST(NEW.amount_atoms AS INTEGER)
    AND EXISTS (
      SELECT 1
      FROM wallets source_wallet
      JOIN operation_funding_legs leg ON leg.id = NEW.funding_leg_id
      JOIN wallet_role_assignments source_role
        ON source_role.business_id = source_wallet.business_id
        AND source_role.wallet_id = source_wallet.id
        AND source_role.enabled = 1
        AND (
          (leg.kind = 'final_payment' AND source_role.role = 'payment')
          OR (
            leg.kind IN ('reserve_replenishment', 'conversion')
            AND source_role.role IN ('reserve', 'operating')
            AND (
              source_role.role = 'reserve'
              OR NOT EXISTS (
                SELECT 1 FROM wallet_role_assignments stricter_reserve
                WHERE stricter_reserve.business_id = source_wallet.business_id
                  AND stricter_reserve.wallet_id = source_wallet.id
                  AND stricter_reserve.role = 'reserve'
                  AND stricter_reserve.enabled = 1
              )
            )
          )
        )
      WHERE source_wallet.id = wallet_balances.wallet_id
        AND leg.source_wallet_id = source_wallet.id
        AND CAST(NEW.amount_atoms AS INTEGER) <= COALESCE(CAST(source_role.maximum_transfer_atoms AS INTEGER), 9223372036854775807)
        AND CAST(confirmed_atoms AS INTEGER) - CAST(reserved_atoms AS INTEGER) - CAST(NEW.amount_atoms AS INTEGER)
            >= CAST(source_role.minimum_remaining_atoms AS INTEGER)
    );
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'managed_reservation_insufficient_balance')
  END;
END;

-- A managed reservation releases its aggregate hold exactly once when its
-- status leaves active. A mismatch aborts the state change.
CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_release_balance
AFTER UPDATE OF status ON reservations
WHEN OLD.reservation_source IN ('managed', 'managed_fee')
  AND OLD.status = 'active'
  AND NEW.status IN ('released', 'consumed', 'expired')
BEGIN
  UPDATE wallet_balances
  SET reserved_atoms = CAST(reserved_atoms AS INTEGER) - CAST(OLD.amount_atoms AS INTEGER),
      observed_at = CASE WHEN NEW.status = 'consumed' THEN datetime('now', '-10 minutes') ELSE observed_at END
  WHERE id = OLD.wallet_balance_id
    AND CAST(reserved_atoms AS INTEGER) >= CAST(OLD.amount_atoms AS INTEGER);
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'managed_reservation_ledger_mismatch')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_managed_reservation_identity_immutable
BEFORE UPDATE OF wallet_balance_id, amount_atoms, reservation_source, funding_leg_id ON reservations
WHEN OLD.reservation_source IN ('managed', 'managed_fee')
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
WHEN OLD.reservation_source IN ('managed', 'managed_fee')
BEGIN
  SELECT RAISE(ABORT, 'managed_reservation_must_be_released_before_delete');
END;


-- SOL network-fee holds are linked to the payment intent rather than a
-- transfer leg. They share the same reservation ledger and atomic accounting.
CREATE TRIGGER IF NOT EXISTS trg_managed_fee_reservation_reserve_balance
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
      AND payment_intent.network_fee_lamports = NEW.amount_atoms
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
