CREATE TABLE IF NOT EXISTS x402_spend_limits (
  scope_key TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  agent_id TEXT REFERENCES agents(id),
  daily_limit_atoms INTEGER NOT NULL CHECK (daily_limit_atoms >= 0),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS x402_payment_challenges (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  request_hash TEXT NOT NULL,
  resource TEXT NOT NULL,
  amount_atoms INTEGER NOT NULL CHECK (amount_atoms > 0),
  pay_to TEXT NOT NULL,
  asset TEXT NOT NULL,
  fee_payer TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reserved', 'settled', 'expired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_x402_challenges_agent_request
  ON x402_payment_challenges(agent_id, request_hash, status, created_at);

CREATE TABLE IF NOT EXISTS x402_payment_reservations (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES x402_payment_challenges(id),
  payment_hash TEXT NOT NULL UNIQUE,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  payment_wallet_address TEXT NOT NULL,
  spend_day TEXT NOT NULL,
  amount_atoms INTEGER NOT NULL CHECK (amount_atoms > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'settled', 'released')),
  receipt_tx TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_x402_reservations_business_day
  ON x402_payment_reservations(business_id, spend_day, status);
CREATE INDEX IF NOT EXISTS idx_x402_reservations_agent_day
  ON x402_payment_reservations(agent_id, spend_day, status);
