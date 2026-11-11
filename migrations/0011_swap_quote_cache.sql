CREATE TABLE IF NOT EXISTS swap_quotes (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operations(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  source_wallet_id TEXT NOT NULL REFERENCES wallets(id),
  user_address TEXT NOT NULL,
  source_amount_atoms TEXT NOT NULL,
  required_output_atoms TEXT NOT NULL,
  quotes_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  build_response_json TEXT,
  build_payment_receipt TEXT,
  built_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_swap_quotes_operation ON swap_quotes(operation_id, agent_id, expires_at);
