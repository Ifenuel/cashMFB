CREATE TABLE IF NOT EXISTS loans (
    id                   SERIAL PRIMARY KEY,
    user_id              INTEGER NOT NULL REFERENCES users(id),
    principal_kobo       BIGINT NOT NULL,
    interest_rate        NUMERIC(5,2) NOT NULL,
    total_repayable_kobo BIGINT NOT NULL,
    amount_repaid_kobo   BIGINT NOT NULL DEFAULT 0,
    status               VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);