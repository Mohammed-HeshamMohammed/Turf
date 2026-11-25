-- The CRM web app's session is handed over from the person's website session (POST /v1/handoffs {kind: "browser"}). It keeps which
-- one, so signing out of the website also signs the CRM out: on a shared computer the next person never opens the last one's CRM.
ALTER TABLE oauth_handoffs ADD COLUMN parent_sid TEXT;
ALTER TABLE sessions ADD COLUMN parent_id TEXT;
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (parent_id) WHERE parent_id IS NOT NULL AND revoked_at IS NULL;
