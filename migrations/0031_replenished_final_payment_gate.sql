-- Final-payment readiness for replenish-then-pay intents is tied to the
-- business intent transition as well as the funding-leg completion gate.
CREATE TRIGGER IF NOT EXISTS trg_replenished_final_leg_requires_ready_intent
BEFORE UPDATE OF status ON operation_funding_legs
WHEN NEW.kind = 'final_payment'
  AND NEW.status IN ('reserved', 'awaiting_signature', 'authorized_for_execution', 'submitted')
  AND EXISTS (
    SELECT 1 FROM business_payment_intents intent
    WHERE intent.operation_id = NEW.operation_id
      AND intent.action = 'replenish_then_pay'
      AND intent.status <> 'awaiting_signature'
      AND NOT EXISTS (
        SELECT 1 FROM operation_funding_legs funding
        WHERE funding.operation_id = leg.operation_id
          AND funding.kind IN ('reserve_replenishment', 'conversion')
          AND funding.status <> 'confirmed'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'final_payment_intent_not_ready');
END;

CREATE TRIGGER IF NOT EXISTS trg_replenished_final_reservation_requires_ready_intent
BEFORE INSERT ON reservations
WHEN NEW.reservation_source = 'managed'
  AND NEW.status = 'active'
  AND EXISTS (
    SELECT 1
    FROM operation_funding_legs leg
    JOIN business_payment_intents intent ON intent.operation_id = leg.operation_id
    WHERE leg.id = NEW.funding_leg_id
      AND leg.kind = 'final_payment'
      AND leg.status = 'reserved'
      AND intent.action = 'replenish_then_pay'
      AND intent.status <> 'awaiting_signature'
      AND NOT EXISTS (
        SELECT 1 FROM operation_funding_legs funding
        WHERE funding.operation_id = leg.operation_id
          AND funding.kind IN ('reserve_replenishment', 'conversion')
          AND funding.status <> 'confirmed'
      )
  )
BEGIN
  SELECT RAISE(ABORT, 'final_payment_intent_not_ready');
END;

-- A funding leg can have only one active managed source reservation. This
-- makes concurrent final-payment preparation attempts fail atomically.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_managed_reservation_per_funding_leg
  ON reservations(funding_leg_id)
  WHERE funding_leg_id IS NOT NULL
    AND reservation_source = 'managed'
    AND status = 'active';
