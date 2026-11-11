ALTER TABLE telegram_connections
  ADD COLUMN permission TEXT NOT NULL DEFAULT 'viewer'
  CHECK (permission IN ('viewer', 'approver'));

CREATE TABLE IF NOT EXISTS telegram_operation_approvals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  snapshot_hash TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(operation_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_operation_approvals_business
  ON telegram_operation_approvals(business_id, decided_at DESC);

CREATE TABLE IF NOT EXISTS telegram_approval_actions (
  token_hash TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  telegram_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  snapshot_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_approval_actions_expiry
  ON telegram_approval_actions(expires_at, consumed_at);
