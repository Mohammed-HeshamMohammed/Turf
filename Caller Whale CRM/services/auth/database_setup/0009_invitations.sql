-- An invitation is bound to the verified email, never to a browser token or a Firebase UID.
-- The role is applied by authorization only when that account accepts it.
CREATE TABLE IF NOT EXISTS access_invitations (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('platform', 'workspace')),
  org_id TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  accepted_at BIGINT,
  revoked_at BIGINT,
  delivery_state TEXT NOT NULL DEFAULT 'pending'
);
CREATE UNIQUE INDEX IF NOT EXISTS access_invitations_open ON access_invitations(scope, org_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS access_invitations_email ON access_invitations(email, expires_at);
