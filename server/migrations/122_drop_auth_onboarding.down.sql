-- Inverse of 122_drop_auth_onboarding.up.sql. Restores the login + onboarding
-- DB surface. Data lost by the up migration is not recoverable; the columns
-- come back empty and the tables come back empty.

ALTER TABLE "user"
  ADD COLUMN cloud_waitlist_reason TEXT,
  ADD COLUMN cloud_waitlist_email VARCHAR(254),
  ADD COLUMN onboarding_questionnaire JSONB NOT NULL DEFAULT '{}';

CREATE TABLE daemon_token (
  -- schema reconstructed from migration 029_daemon_token.up.sql
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  daemon_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE personal_access_token (
  -- schema reconstructed from migration 011_personal_access_tokens.up.sql
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_code (
  -- schema reconstructed from migration 009_verification_code.up.sql
  id UUID PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);