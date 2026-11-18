-- Build step 24: an outside AI connected through MCP asks for a risky change (inviting, removing, changing someone's roles, deleting a
-- team, cancelling an invitation); the person confirms it inside Caller Whale, and only then is it made, as them (D130). Nothing that
-- spends money can be asked for (D131).
CREATE TABLE connector_requests (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_name TEXT NOT NULL DEFAULT '',
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  decided_at BIGINT,
  decision TEXT NOT NULL DEFAULT '',
  result_status INT,
  result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX connector_requests_waiting ON connector_requests (user_id) WHERE decided_at IS NULL;
