CREATE TABLE telegram_connections_new (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  chat_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  permission TEXT NOT NULL DEFAULT 'viewer'
    CHECK (permission IN ('viewer', 'requester', 'approver')),
  UNIQUE(business_id, chat_id, telegram_user_id)
);

INSERT INTO telegram_connections_new (
  id, business_id, chat_id, telegram_user_id, status, linked_at, permission
)
SELECT
  id, business_id, chat_id, telegram_user_id, status, linked_at, permission
FROM telegram_connections;

DROP TABLE telegram_connections;

ALTER TABLE telegram_connections_new RENAME TO telegram_connections;
