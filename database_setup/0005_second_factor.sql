-- The second step at sign-in (docs/plans/second-factor.md): authenticator devices, Telegram, and the one-time challenges
-- that email codes, Telegram codes and approvals in the app all go through. Same portable SQL as the others.

-- One row per way a person set up: "totp" (an authenticator app, up to three devices) or "telegram" (one chat). Email
-- has no row: it is the account's own address.
CREATE TABLE IF NOT EXISTS mfa_factors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  secret TEXT NOT NULL,                 -- totp: the base32 secret; telegram: the chat id
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  n BIGINT NOT NULL                     -- 1, 2, 3 ... per person, in the order they were set up
);
CREATE INDEX IF NOT EXISTS mfa_factors_user ON mfa_factors(user_id, kind, created_at);

-- One row per second-step attempt, for ten minutes. Only the hash of the challenge secret (and of a code) is kept.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT,                      -- the open session a step-up is for; empty for a sign-in
  session_kind TEXT NOT NULL,           -- browser or desktop, for a sign-in
  provider TEXT NOT NULL,
  fb_refresh TEXT,                      -- carried to the session a sign-in opens
  code_hash TEXT,
  code_method TEXT,                     -- email or telegram
  code_sent_at BIGINT,
  code_expires_at BIGINT,
  tries BIGINT NOT NULL DEFAULT 0,
  push_state TEXT NOT NULL DEFAULT 'none',   -- none, pending, approved or denied
  push_label TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS mfa_challenges_user ON mfa_challenges(user_id, push_state);

-- A one-time link waiting for the person to open it in Telegram. Only the hash is kept.
CREATE TABLE IF NOT EXISTS telegram_links (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
