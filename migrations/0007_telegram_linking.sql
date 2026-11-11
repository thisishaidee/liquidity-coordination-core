CREATE TABLE IF NOT EXISTS telegram_link_codes (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  code_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS telegram_connections (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(business_id, chat_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_connections_business ON telegram_connections(business_id, status);
