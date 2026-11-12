ALTER TABLE telegram_connections ADD COLUMN totp_secret_enc TEXT;
ALTER TABLE telegram_connections ADD COLUMN totp_enabled_at TEXT;

CREATE TABLE IF NOT EXISTS telegram_totp_enrollments (
  business_id TEXT NOT NULL REFERENCES businesses(id),
  chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  encrypted_secret TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (business_id, chat_id, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS telegram_pending_approvals (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  operation_id TEXT NOT NULL REFERENCES operations(id),
  telegram_chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  snapshot_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_approvals_expiry
  ON telegram_pending_approvals(expires_at);

ALTER TABLE telegram_connections ADD COLUMN last_totp_step INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_pending_approvals_operation
  ON telegram_pending_approvals(operation_id);
