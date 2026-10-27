-- The auth service's own tables. Written in the SQL that both PostgreSQL (production) and SQLite (tests and local
-- development) accept: ids are text, times are Unix seconds, flags are 0 or 1. No other service reads these tables.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,           -- stored lower-case
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- Argon2id
  totp_secret TEXT,                     -- base32, set once two-step sign-in is confirmed
  totp_pending TEXT,                    -- base32, waiting for its first code
  disabled_at BIGINT,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at BIGINT,
  PRIMARY KEY (user_id, code_hash)
);

-- One row per signed-in device. The refresh token is stored only as a hash and changes every time it is used; the
-- previous hash is kept so a stolen, already-used token is recognised and ends the session.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash TEXT NOT NULL UNIQUE,
  prev_refresh_hash TEXT,
  kind TEXT NOT NULL,                   -- browser or desktop
  mfa_passed BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Failed sign-ins, for the five-in-fifteen-minutes pause.
CREATE TABLE IF NOT EXISTS failed_sign_ins (
  email TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS failed_sign_ins_email ON failed_sign_ins(email, at);

-- Events for the bus (contracts/events.md), written in the same transaction as the change and sent later.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  sent_at BIGINT
);
