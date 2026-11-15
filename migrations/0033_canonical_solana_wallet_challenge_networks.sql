-- Normalize wallet ownership challenges to canonical Solana CAIP-2 chain IDs
-- and allow the dedicated devnet Worker to verify devnet wallets.
CREATE TABLE wallet_ownership_challenges_v2 (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  origin TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN (
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
  )),
  message TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE,
  signature_hash TEXT,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO wallet_ownership_challenges_v2 (
  id, business_id, wallet_id, address, origin, network, message, nonce_hash,
  signature_hash, issued_at, expires_at, consumed_at, verified_at, created_at
)
SELECT
  id, business_id, wallet_id, address, origin,
  CASE network
    WHEN 'solana:mainnet-beta' THEN 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
    ELSE network
  END,
  message, nonce_hash, signature_hash, issued_at, expires_at, consumed_at, verified_at, created_at
FROM wallet_ownership_challenges;

DROP TABLE wallet_ownership_challenges;
ALTER TABLE wallet_ownership_challenges_v2 RENAME TO wallet_ownership_challenges;

CREATE INDEX IF NOT EXISTS idx_wallet_ownership_challenges_wallet_created
  ON wallet_ownership_challenges(wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_ownership_challenges_expiry
  ON wallet_ownership_challenges(expires_at)
  WHERE consumed_at IS NULL;
