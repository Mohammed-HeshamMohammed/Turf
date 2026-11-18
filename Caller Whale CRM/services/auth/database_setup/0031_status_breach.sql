-- Build step 34: the public status page, the outage banner and owners' emails (D235), and breach notices to agency owners within 72
-- hours (D236).
CREATE TABLE status_incidents (
  id TEXT PRIMARY KEY,
  components TEXT NOT NULL,          -- comma separated: sign_in, crm, calls, texts, chats, email
  severity TEXT NOT NULL CHECK (severity IN ('degraded', 'down')),
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  started_at BIGINT NOT NULL,
  resolved_at BIGINT,
  created_by TEXT NOT NULL,
  updates TEXT NOT NULL DEFAULT '[]'  -- [{at, message}]
);
CREATE INDEX status_incidents_open ON status_incidents (started_at) WHERE resolved_at IS NULL;

-- The last automatic check of each part, when STATUS_PROBES is set.
CREATE TABLE status_probes (
  component TEXT PRIMARY KEY,
  ok BOOLEAN NOT NULL,
  failures INT NOT NULL DEFAULT 0,
  since BIGINT NOT NULL,
  checked_at BIGINT NOT NULL
);

-- People who want an email when something is down (D235).
CREATE TABLE status_subscribers (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  since BIGINT NOT NULL
);

CREATE TABLE breach_notices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  discovered_at BIGINT NOT NULL,     -- when Caller Whale knew; the owner is told within 72 hours of it
  what TEXT NOT NULL,
  to_do TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  sent_to TEXT NOT NULL DEFAULT '',
  sent_at BIGINT,
  failed TEXT NOT NULL DEFAULT ''
);
CREATE INDEX breach_notices_org ON breach_notices (org_id);
