-- THROWAWAY POC: drop the login + onboarding DB surface. DevBypass is the
-- sole identity path, so the verification-code / personal-access-token /
-- daemon-token tables and the user onboarding-questionnaire + cloud-waitlist
-- columns are dead. onboarded_at is kept — DevBypass still stamps it on the
-- provisioned dev user. NEVER MERGE.

DROP TABLE IF EXISTS verification_code;
DROP TABLE IF EXISTS personal_access_token;
DROP TABLE IF EXISTS daemon_token;

ALTER TABLE "user"
  DROP COLUMN IF EXISTS onboarding_questionnaire,
  DROP COLUMN IF EXISTS cloud_waitlist_email,
  DROP COLUMN IF EXISTS cloud_waitlist_reason;