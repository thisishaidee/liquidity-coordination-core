ALTER TABLE operations ADD COLUMN source_wallet_id TEXT REFERENCES wallets(id);
