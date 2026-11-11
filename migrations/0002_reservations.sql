CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  wallet_balance_id TEXT NOT NULL REFERENCES wallet_balances(id),
  amount_atoms TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed', 'expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_reservations_operation ON reservations(operation_id);
CREATE INDEX IF NOT EXISTS idx_reservations_status_expiry ON reservations(status, expires_at);
