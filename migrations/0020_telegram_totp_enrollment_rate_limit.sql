ALTER TABLE telegram_totp_enrollments ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
