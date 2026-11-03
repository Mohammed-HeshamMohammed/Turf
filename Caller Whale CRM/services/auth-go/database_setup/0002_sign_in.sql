-- Google and Apple sign-in, the desktop handoff and email confirmation, moved here from the core API.
-- Same portable SQL as 0001: text ids, Unix-second times, 0/1 flags.

-- When the person confirmed their email address. Google and Apple confirm it for us.
ALTER TABLE users ADD COLUMN email_verified_at BIGINT;

-- Accounts linked to an outside sign-in. The provider's subject is the stable key; the email is only what it said then.
CREATE TABLE IF NOT EXISTS user_identities (
  provider TEXT NOT NULL,               -- google or apple
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);

-- One row per sign-in started with a provider, used once and only for ten minutes. Only the state's hash is kept.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT,
  target TEXT NOT NULL,                 -- website, app or desktop
  return_port BIGINT,                   -- desktop only: the app's port on 127.0.0.1
  expires_at BIGINT NOT NULL
);

-- A finished provider sign-in waiting for the app, website or desktop app to collect it as tokens: once, within two
-- minutes. Only the hash is kept.
CREATE TABLE IF NOT EXISTS oauth_handoffs (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                   -- browser or desktop
  expires_at BIGINT NOT NULL
);

-- Email confirmation links: used once, for two days. Only the hash is kept.
CREATE TABLE IF NOT EXISTS email_verifications (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
);
CREATE INDEX IF NOT EXISTS email_verifications_user ON email_verifications(user_id, created_at);
