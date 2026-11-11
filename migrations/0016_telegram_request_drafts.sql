CREATE TABLE IF NOT EXISTS telegram_request_drafts (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  step TEXT NOT NULL CHECK (step IN ('agent', 'amount', 'purpose', 'confirm')),
  agent_id TEXT REFERENCES agents(id),
  amount TEXT,
  purpose TEXT,
  task_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, chat_id, telegram_user_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_request_drafts_expiry
  ON telegram_request_drafts(expires_at);

CREATE TABLE IF NOT EXISTS telegram_request_origins (
  operation_id TEXT PRIMARY KEY REFERENCES operations(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  telegram_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_request_origins_business
  ON telegram_request_origins(business_id, created_at DESC);
