-- Business-controlled payment policy and idempotent payment-intent records.
CREATE TABLE IF NOT EXISTS business_payment_policies (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  allowed_mints TEXT NOT NULL CHECK (json_valid(allowed_mints) AND json_type(allowed_mints) = 'array'),
  allowed_destinations TEXT NOT NULL CHECK (json_valid(allowed_destinations) AND json_type(allowed_destinations) = 'array'),
  allowed_conversion_mints TEXT NOT NULL CHECK (json_valid(allowed_conversion_mints) AND json_type(allowed_conversion_mints) = 'array'),
  max_transaction_atoms TEXT NOT NULL,
  max_network_fee_lamports TEXT NOT NULL,
  allowed_fee_payer_wallet_ids TEXT NOT NULL CHECK (json_valid(allowed_fee_payer_wallet_ids) AND json_type(allowed_fee_payer_wallet_ids) = 'array'),
  max_daily_atoms TEXT NOT NULL,
  max_balance_age_seconds INTEGER NOT NULL CHECK (max_balance_age_seconds BETWEEN 1 AND 86400),
  max_intent_lifetime_seconds INTEGER NOT NULL CHECK (max_intent_lifetime_seconds BETWEEN 60 AND 86400),
  max_slippage_bps INTEGER NOT NULL CHECK (max_slippage_bps BETWEEN 0 AND 10000),
  allow_conversion INTEGER NOT NULL DEFAULT 0 CHECK (allow_conversion IN (0, 1)),
  allow_partial_payment INTEGER NOT NULL DEFAULT 0 CHECK (allow_partial_payment IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_payment_intents (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  destination TEXT NOT NULL,
  mint TEXT NOT NULL,
  requested_atoms TEXT NOT NULL,
  payment_atoms TEXT NOT NULL,
  fee_payer_wallet_id TEXT NOT NULL REFERENCES wallets(id),
  network_fee_lamports TEXT NOT NULL,
  allow_partial_payment INTEGER NOT NULL DEFAULT 0 CHECK (allow_partial_payment IN (0, 1)),
  slippage_bps INTEGER CHECK (slippage_bps BETWEEN 0 AND 10000),
  action TEXT NOT NULL CHECK (action IN ('direct_payment', 'replenish_then_pay', 'partial_payment', 'conversion_required')),
  status TEXT NOT NULL CHECK (status IN (
    'policy_checked', 'reserved', 'replenishing', 'awaiting_owner_approval',
    'awaiting_signature', 'submitted', 'confirmed', 'failed', 'expired', 'ambiguous', 'cancelled'
  )),
  policy_version INTEGER NOT NULL,
  policy_snapshot TEXT NOT NULL CHECK (json_valid(policy_snapshot)),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(business_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_business_payment_intents_business_created
  ON business_payment_intents(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_payment_intents_status_expiry
  ON business_payment_intents(status, expires_at);

CREATE TRIGGER IF NOT EXISTS trg_business_payment_intent_identity_immutable
BEFORE UPDATE OF business_id, operation_id, idempotency_key, destination, mint,
                 requested_atoms, payment_atoms, fee_payer_wallet_id,
                 network_fee_lamports, allow_partial_payment, slippage_bps, action, policy_version, policy_snapshot, expires_at, created_at
ON business_payment_intents
WHEN NEW.business_id IS NOT OLD.business_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.destination IS NOT OLD.destination
  OR NEW.mint IS NOT OLD.mint
  OR NEW.requested_atoms IS NOT OLD.requested_atoms
  OR NEW.payment_atoms IS NOT OLD.payment_atoms
  OR NEW.fee_payer_wallet_id IS NOT OLD.fee_payer_wallet_id
  OR NEW.network_fee_lamports IS NOT OLD.network_fee_lamports
  OR NEW.allow_partial_payment IS NOT OLD.allow_partial_payment
  OR NEW.slippage_bps IS NOT OLD.slippage_bps
  OR NEW.action IS NOT OLD.action
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.policy_snapshot IS NOT OLD.policy_snapshot
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'business_payment_intent_identity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_business_payment_intent_state_transition
BEFORE UPDATE OF status ON business_payment_intents
WHEN NOT (
  OLD.status = NEW.status
  OR (OLD.status = 'policy_checked' AND NEW.status IN ('reserved', 'replenishing', 'awaiting_owner_approval', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'reserved' AND NEW.status IN ('awaiting_signature', 'submitted', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'replenishing' AND NEW.status IN ('awaiting_signature', 'failed', 'ambiguous', 'expired', 'cancelled'))
  OR (OLD.status = 'awaiting_owner_approval' AND NEW.status IN ('policy_checked', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'awaiting_signature' AND NEW.status IN ('submitted', 'failed', 'expired', 'cancelled'))
  OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'ambiguous'))
  OR (OLD.status = 'ambiguous' AND NEW.status IN ('confirmed', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_business_payment_intent_transition');
END;

CREATE TRIGGER IF NOT EXISTS trg_business_payment_intent_scope_insert
BEFORE INSERT ON business_payment_intents
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM operations op
    JOIN agents a ON a.id = op.agent_id AND a.business_id = op.business_id
    JOIN wallets fee_wallet ON fee_wallet.id = NEW.fee_payer_wallet_id
    WHERE op.id = NEW.operation_id
      AND op.business_id = NEW.business_id
      AND fee_wallet.business_id = NEW.business_id
      AND fee_wallet.scope = 'business'
      AND fee_wallet.status = 'active'
      AND fee_wallet.network = 'solana'
      AND fee_wallet.ownership_verified_at IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM wallet_role_assignments fee_role
        WHERE fee_role.business_id = fee_wallet.business_id
          AND fee_role.wallet_id = fee_wallet.id
          AND fee_role.enabled = 1
          AND fee_role.role IN ('payment', 'operating')
      )
  ) THEN RAISE(ABORT, 'business_payment_intent_scope_invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM business_payment_policies p
    WHERE p.business_id = NEW.business_id AND p.version = NEW.policy_version
  ) THEN RAISE(ABORT, 'business_payment_policy_version_changed') END;
END;


-- Re-check mutable policy constraints at the database boundary. The daily
-- aggregate is serialized with intent insertion, preventing concurrent
-- requests from both spending the same remaining daily allowance.
CREATE TRIGGER IF NOT EXISTS trg_business_payment_intent_policy_guard
BEFORE INSERT ON business_payment_intents
BEGIN
  SELECT CASE WHEN NEW.network_fee_lamports IS NULL
    OR NEW.network_fee_lamports = ''
    OR NEW.network_fee_lamports GLOB '*[^0-9]*'
    OR length(NEW.network_fee_lamports) > 19
    OR (length(NEW.network_fee_lamports) = 19 AND NEW.network_fee_lamports > '9223372036854775807')
    THEN RAISE(ABORT, 'business_payment_network_fee_invalid') END;

  SELECT CASE WHEN NEW.requested_atoms IS NULL
    OR NEW.requested_atoms = ''
    OR NEW.requested_atoms GLOB '*[^0-9]*'
    OR substr(NEW.requested_atoms, 1, 1) = '0'
    OR length(NEW.requested_atoms) > 19
    OR (length(NEW.requested_atoms) = 19 AND NEW.requested_atoms > '9223372036854775807')
    OR NEW.payment_atoms IS NULL
    OR NEW.payment_atoms = ''
    OR NEW.payment_atoms GLOB '*[^0-9]*'
    OR substr(NEW.payment_atoms, 1, 1) = '0'
    OR length(NEW.payment_atoms) > 19
    OR (length(NEW.payment_atoms) = 19 AND NEW.payment_atoms > '9223372036854775807')
    OR CAST(NEW.payment_atoms AS INTEGER) > CAST(NEW.requested_atoms AS INTEGER)
    THEN RAISE(ABORT, 'business_payment_amount_invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM business_payment_policies p
    WHERE p.business_id = NEW.business_id
      AND EXISTS (SELECT 1 FROM json_each(p.allowed_mints) WHERE value = NEW.mint)
      AND EXISTS (SELECT 1 FROM json_each(p.allowed_destinations) WHERE value = NEW.destination)
      AND EXISTS (SELECT 1 FROM json_each(p.allowed_fee_payer_wallet_ids) WHERE value = NEW.fee_payer_wallet_id)
      AND CAST(NEW.payment_atoms AS INTEGER) <= CAST(p.max_transaction_atoms AS INTEGER)
      AND CAST(NEW.network_fee_lamports AS INTEGER) <= CAST(p.max_network_fee_lamports AS INTEGER)
  ) THEN RAISE(ABORT, 'business_payment_policy_constraint_failed') END;

  SELECT CASE WHEN (
    SELECT COALESCE(SUM(CAST(payment_atoms AS INTEGER)), 0)
    FROM business_payment_intents existing
    WHERE existing.business_id = NEW.business_id
      AND existing.created_at >= date('now')
      AND existing.status IN (
        'reserved', 'replenishing', 'awaiting_owner_approval',
        'awaiting_signature', 'submitted', 'confirmed', 'ambiguous'
      )
  ) > (
    SELECT CAST(p.max_daily_atoms AS INTEGER) - CAST(NEW.payment_atoms AS INTEGER)
    FROM business_payment_policies p WHERE p.business_id = NEW.business_id
  ) THEN RAISE(ABORT, 'business_payment_daily_limit_exceeded') END;
END;
