-- Telegram identities can sign in to a business dashboard with explicit web roles.
ALTER TABLE telegram_connections ADD COLUMN dashboard_role TEXT NOT NULL DEFAULT 'analyst'
  CHECK (dashboard_role IN ('admin', 'analyst'));
ALTER TABLE telegram_link_codes ADD COLUMN dashboard_role TEXT NOT NULL DEFAULT 'analyst'
  CHECK (dashboard_role IN ('admin', 'analyst'));
ALTER TABLE admin_sessions ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner', 'admin', 'analyst'));
ALTER TABLE admin_sessions ADD COLUMN telegram_user_id TEXT;
CREATE TABLE IF NOT EXISTS telegram_login_tickets (
  token_hash TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'analyst')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_telegram_login_tickets_expiry ON telegram_login_tickets(expires_at, consumed_at);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_business_expiry_role ON admin_sessions(business_id, expires_at, role);
