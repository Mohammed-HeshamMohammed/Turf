-- Google sign-in from the desktop app: the browser finishes it and hands a one-time code to the app on this computer.

ALTER TABLE oauth_states DROP CONSTRAINT oauth_states_target_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_target_check CHECK (target IN ('website', 'app', 'desktop'));
-- The port the desktop app listens on at 127.0.0.1, for target 'desktop' only.
ALTER TABLE oauth_states ADD COLUMN return_port int CHECK (return_port BETWEEN 1024 AND 65535);

-- A finished sign-in waiting for the desktop app to collect it: used once, within two minutes. Only the hash is kept.
CREATE TABLE oauth_handoffs (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, DELETE ON oauth_handoffs TO turf_app;
