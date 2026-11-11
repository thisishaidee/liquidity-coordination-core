CREATE TABLE IF NOT EXISTS liquidity_obligations (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  task_id TEXT NOT NULL,
  token TEXT NOT NULL DEFAULT 'USDC' CHECK (token = 'USDC'),
  amount_atoms TEXT NOT NULL,
  due_at TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'fulfilled', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(agent_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_obligations_agent_due ON liquidity_obligations(agent_id, status, due_at);
