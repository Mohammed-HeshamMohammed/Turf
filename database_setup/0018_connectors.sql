-- Assistants (Claude, ChatGPT, Gemini) that may act for a person: the assistants that registered, the one-time codes of a consent in progress,
-- what each person allowed, and the tokens handed out (only hashes are kept). docs/plans/ai-connectors.md
CREATE TABLE connector_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE connector_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX connector_grants_user ON connector_grants (user_id);
CREATE TABLE connector_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE connector_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX connector_tokens_grant ON connector_tokens (grant_id);
