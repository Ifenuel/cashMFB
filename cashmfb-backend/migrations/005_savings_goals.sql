CREATE TABLE IF NOT EXISTS savings_goals (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    name         VARCHAR(100) NOT NULL,
    target_kobo  BIGINT NOT NULL CHECK (target_kobo > 0),
    saved_kobo   BIGINT NOT NULL DEFAULT 0,
    status       VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_savings_goals_user ON savings_goals(user_id);