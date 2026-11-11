ALTER TABLE wallet_balances
ADD COLUMN source TEXT NOT NULL DEFAULT 'manual_admin';
