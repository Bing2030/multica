-- Restore the personal_access_token table (dropped in 122 for the
-- THROWAWAY POC DevBypass). The daemon requires a non-empty token in
-- ~/.multica/config.json, and the web UI's Settings → Tokens tab
-- creates them via /api/tokens.

CREATE TABLE IF NOT EXISTS personal_access_token (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_token(user_id, revoked);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pat_token_hash ON personal_access_token(token_hash);
