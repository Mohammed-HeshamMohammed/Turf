-- Build step 13: handing an agency to a new owner (D28, D70, D199, D200), and an admin taking over an agency whose owner is gone (D27,
-- D201). One open handover or takeover per agency at a time.
CREATE TABLE ownership_handovers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('handover', 'takeover')),
  from_user TEXT NOT NULL,
  to_user TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  old_roles TEXT[] NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  completed_at BIGINT,
  cancelled_at BIGINT,
  cancelled_reason TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX one_open_handover ON ownership_handovers (org_id) WHERE completed_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX handovers_to ON ownership_handovers (to_user) WHERE completed_at IS NULL AND cancelled_at IS NULL;

-- Agencies Caller Whale's staff paused because their owner cannot be reached, and since when (D27, D201).
CREATE TABLE paused_workspaces (
  org_id TEXT PRIMARY KEY,
  paused_at BIGINT NOT NULL
);
