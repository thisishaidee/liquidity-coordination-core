-- Wallet ownership proof is separate from wallet registration, role assignment and execution authority.
ALTER TABLE wallets ADD COLUMN ownership_verified_at TEXT;
ALTER TABLE wallets ADD COLUMN ownership_verified_origin TEXT;

CREATE TABLE IF NOT EXISTS wallet_ownership_challenges (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  origin TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'solana:mainnet-beta'),
  message TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  signature_hash TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_ownership_challenges_wallet_created
  ON wallet_ownership_challenges(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ownership_challenges_expiry
  ON wallet_ownership_challenges(expires_at)
  WHERE consumed_at IS NULL;

-- Legacy backfilled liquidity roles are not eligible for future autonomous
-- funding until the wallet owner proves address control. Keep the dedicated
-- API-payment classification intact for the existing x402 client flow.
UPDATE wallet_role_assignments
SET enabled = 0, updated_at = datetime('now')
WHERE role <> 'api_payment'
  AND wallet_id IN (SELECT id FROM wallets WHERE ownership_verified_at IS NULL);

-- A changed address, network, business association or wallet scope invalidates
-- the proof and disables liquidity roles until the new identity is verified.
CREATE TRIGGER IF NOT EXISTS trg_wallet_ownership_reset_on_identity_change
AFTER UPDATE OF address, network, business_id, scope ON wallets
WHEN NEW.address <> OLD.address
  OR NEW.network <> OLD.network
  OR NEW.business_id <> OLD.business_id
  OR NEW.scope <> OLD.scope
BEGIN
  UPDATE wallets
  SET ownership_verified_at = NULL, ownership_verified_origin = NULL
  WHERE id = NEW.id;
  UPDATE wallet_role_assignments
  SET enabled = 0, updated_at = datetime('now')
  WHERE wallet_id = NEW.id AND role <> 'api_payment';
  DELETE FROM wallet_ownership_challenges WHERE wallet_id = NEW.id;
END;
