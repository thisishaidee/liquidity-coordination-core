PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  can_use_business_treasury INTEGER NOT NULL DEFAULT 0 CHECK (can_use_business_treasury IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  agent_id TEXT REFERENCES agents(id),
  network TEXT NOT NULL,
  address TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('agent', 'business')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  UNIQUE(network, address)
);

CREATE TABLE IF NOT EXISTS wallet_balances (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id),
  token TEXT NOT NULL,
  confirmed_atoms TEXT NOT NULL,
  reserved_atoms TEXT NOT NULL DEFAULT '0',
  observed_at TEXT NOT NULL,
  UNIQUE(wallet_id, token)
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL,
  network TEXT NOT NULL,
  token TEXT NOT NULL,
  amount_atoms TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL,
  action TEXT NOT NULL,
  available_atoms TEXT NOT NULL,
  shortfall_atoms TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_agents_business ON agents(business_id);
CREATE INDEX IF NOT EXISTS idx_wallets_business ON wallets(business_id);
CREATE INDEX IF NOT EXISTS idx_balances_wallet ON wallet_balances(wallet_id);
CREATE INDEX IF NOT EXISTS idx_operations_business_created ON operations(business_id, created_at);
