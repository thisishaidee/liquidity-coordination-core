-- A final payment leg cannot be reserved or advanced until every
-- replenishment/conversion leg for the same operation is confirmed.
CREATE TRIGGER IF NOT EXISTS trg_final_payment_leg_requires_confirmed_funding
BEFORE UPDATE OF status ON operation_funding_legs
WHEN NEW.kind = 'final_payment'
  AND NEW.status IN ('reserved', 'awaiting_signature', 'authorized_for_execution', 'submitted')
  AND EXISTS (
    SELECT 1 FROM operation_funding_legs funding
    WHERE funding.operation_id = NEW.operation_id
      AND funding.kind IN ('reserve_replenishment', 'conversion')
      AND funding.status <> 'confirmed'
  )
BEGIN
  SELECT RAISE(ABORT, 'final_payment_requires_confirmed_funding');

END;

CREATE TRIGGER IF NOT EXISTS trg_final_payment_reservation_requires_confirmed_funding
BEFORE INSERT ON reservations
WHEN NEW.reservation_source = 'managed'
  AND NEW.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM operation_funding_legs payment_leg
    WHERE payment_leg.id = NEW.funding_leg_id
      AND payment_leg.kind = 'final_payment'
      AND (
        payment_leg.status <> 'reserved'
        OR EXISTS (
          SELECT 1 FROM operation_funding_legs funding
          WHERE funding.operation_id = payment_leg.operation_id
            AND funding.kind IN ('reserve_replenishment', 'conversion')
            AND funding.status <> 'confirmed'
        )
      )
  )
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM operation_funding_legs payment_leg
    JOIN operation_funding_legs funding
      ON funding.operation_id = payment_leg.operation_id
    WHERE payment_leg.id = NEW.funding_leg_id
      AND payment_leg.kind = 'final_payment'
      AND funding.kind IN ('reserve_replenishment', 'conversion')
      AND funding.status <> 'confirmed'
  ) THEN RAISE(ABORT, 'final_payment_requires_confirmed_funding') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM operation_funding_legs payment_leg
    WHERE payment_leg.id = NEW.funding_leg_id
      AND payment_leg.kind = 'final_payment'
      AND payment_leg.status <> 'reserved'
  ) THEN RAISE(ABORT, 'final_payment_leg_not_reserved') END;
END;
