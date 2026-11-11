ALTER TABLE reservations
ADD COLUMN token TEXT NOT NULL DEFAULT 'USDC';

ALTER TABLE operations
ADD COLUMN transaction_hash TEXT;

ALTER TABLE operations
ADD COLUMN provider_key TEXT;

ALTER TABLE operations
ADD COLUMN source_reservation_id TEXT;
