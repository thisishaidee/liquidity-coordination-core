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
