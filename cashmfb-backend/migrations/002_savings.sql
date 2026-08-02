ALTER TABLE wallets ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'main';
ALTER TABLE wallets ADD CONSTRAINT unique_user_wallet_type UNIQUE (user_id, type);