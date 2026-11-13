-- Existing sessions were authenticated with a platform-wide token and have no tenant boundary.
-- Invalidate them before requiring every new session to be bound to one business.
ALTER TABLE admin_sessions ADD COLUMN business_id TEXT REFERENCES businesses(id);
DELETE FROM admin_sessions;
CREATE INDEX IF NOT EXISTS idx_admin_sessions_business_expiry
  ON admin_sessions(business_id, expires_at);
