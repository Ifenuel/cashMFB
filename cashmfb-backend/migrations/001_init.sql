CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    full_name     VARCHAR(120) NOT NULL,
    email         VARCHAR(160) UNIQUE NOT NULL,
    phone         VARCHAR(20)  UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    balance     BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency    VARCHAR(3) NOT NULL DEFAULT 'NGN',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
    id          SERIAL PRIMARY KEY,
    reference   VARCHAR(40) UNIQUE NOT NULL,
    type        VARCHAR(20) NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'success',
    narration   VARCHAR(255),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    id             SERIAL PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id),
    wallet_id      INTEGER NOT NULL REFERENCES wallets(id),
    direction      VARCHAR(6) NOT NULL CHECK (direction IN ('debit','credit')),
    amount         BIGINT NOT NULL CHECK (amount > 0),
    balance_after  BIGINT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_wallet ON ledger_entries(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets(user_id);