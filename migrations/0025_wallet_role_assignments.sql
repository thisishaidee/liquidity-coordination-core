-- Additive role model for business-owned wallets.
-- Legacy wallets.purpose remains unchanged for compatibility with existing routes.
CREATE TABLE IF NOT EXISTS wallet_role_assignments (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('payment', 'reserve', 'operating', 'receiving', 'api_payment')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  minimum_remaining_atoms TEXT NOT NULL DEFAULT '0',
  maximum_transfer_atoms TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (wallet_id, role)
);

-- A business may have only one active designated payment wallet.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_roles_one_payment_per_business
  ON wallet_role_assignments(business_id)
  WHERE role = 'payment' AND enabled = 1;

CREATE INDEX IF NOT EXISTS idx_wallet_roles_business_role_enabled
  ON wallet_role_assignments(business_id, role, enabled, priority);

-- Enforce that assignments are attached only to a wallet in the same business
-- and never to an agent-scoped wallet.
CREATE TRIGGER IF NOT EXISTS trg_wallet_role_business_scope_insert
BEFORE INSERT ON wallet_role_assignments
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.id = NEW.wallet_id
      AND w.business_id = NEW.business_id
      AND w.scope = 'business'
  ) THEN RAISE(ABORT, 'wallet_role_requires_matching_business_wallet') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_wallet_role_business_scope_update
BEFORE UPDATE OF business_id, wallet_id ON wallet_role_assignments
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM wallets w
    WHERE w.id = NEW.wallet_id
      AND w.business_id = NEW.business_id
      AND w.scope = 'business'
  ) THEN RAISE(ABORT, 'wallet_role_requires_matching_business_wallet') END;
END;

-- The dedicated x402 fee wallet must never also be treated as payment liquidity.
CREATE TRIGGER IF NOT EXISTS trg_wallet_role_api_payment_insert
BEFORE INSERT ON wallet_role_assignments
BEGIN
  SELECT CASE WHEN NEW.role = 'api_payment' AND EXISTS (
    SELECT 1 FROM wallet_role_assignments r WHERE r.wallet_id = NEW.wallet_id
  ) THEN RAISE(ABORT, 'api_payment_role_must_be_exclusive') END;
  SELECT CASE WHEN NEW.role <> 'api_payment' AND EXISTS (
    SELECT 1 FROM wallet_role_assignments r WHERE r.wallet_id = NEW.wallet_id AND r.role = 'api_payment'
  ) THEN RAISE(ABORT, 'api_payment_role_must_be_exclusive') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_wallet_role_api_payment_update
BEFORE UPDATE OF wallet_id, role ON wallet_role_assignments
BEGIN
  SELECT CASE WHEN NEW.role = 'api_payment' AND EXISTS (
    SELECT 1 FROM wallet_role_assignments r
    WHERE r.wallet_id = NEW.wallet_id AND r.role <> OLD.role
  ) THEN RAISE(ABORT, 'api_payment_role_must_be_exclusive') END;
  SELECT CASE WHEN NEW.role <> 'api_payment' AND EXISTS (
    SELECT 1 FROM wallet_role_assignments r
    WHERE r.wallet_id = NEW.wallet_id AND r.role = 'api_payment' AND r.role <> OLD.role
  ) THEN RAISE(ABORT, 'api_payment_role_must_be_exclusive') END;
END;

-- Backfill the current business-wallet model without changing legacy purpose.
INSERT OR IGNORE INTO wallet_role_assignments (business_id, wallet_id, role, enabled)
SELECT business_id, id,
       CASE WHEN purpose = 'api_payment' THEN 'api_payment' ELSE 'operating' END,
       CASE WHEN status = 'active' THEN 1 ELSE 0 END
FROM wallets
WHERE scope = 'business';
