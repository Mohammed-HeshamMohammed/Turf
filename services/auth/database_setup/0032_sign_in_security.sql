-- Build step 35: sign-in security.
--   * Which device and rough place each session came from; a sign-in from a device the person never used sends an email with a
--     "This wasn't me" link that signs that session out and starts a password reset (D242). Only the first three parts of an IPv4
--     address (or the first four of IPv6) are kept.
--   * Each agency's idle limit before people are signed out, 8 hours by default; a call in progress never times out (D244).
--   * Someone who lost both their authenticator and their recovery codes asks support, who check and wait 7 days (D239).
ALTER TABLE sessions ADD COLUMN device TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN device_key TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN country TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN network TEXT NOT NULL DEFAULT '';
CREATE INDEX sessions_device ON sessions (user_id, device_key);

CREATE TABLE not_me_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);

CREATE TABLE org_security (
  org_id TEXT PRIMARY KEY,
  idle_minutes INT NOT NULL DEFAULT 480 CHECK (idle_minutes BETWEEN 15 AND 10080),
  set_by TEXT NOT NULL,
  set_at BIGINT NOT NULL
);

CREATE TABLE reset_support_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  ready_at BIGINT NOT NULL,          -- staff may approve only after the waiting period
  decided_at BIGINT,
  decided_by TEXT,
  decision TEXT NOT NULL DEFAULT ''
);
