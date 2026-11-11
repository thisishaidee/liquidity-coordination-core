ALTER TABLE wallets ADD COLUMN purpose TEXT NOT NULL DEFAULT 'operating' CHECK (purpose IN ('operating', 'api_payment'));
