ALTER TABLE telegram_request_drafts
  ADD COLUMN agent_choices TEXT NOT NULL DEFAULT '[]';
