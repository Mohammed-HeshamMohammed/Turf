-- One invitation carries everything (build step 3, D45): several roles, the teams an agent joins (several under the new team rules),
-- and for a team lead the teams they will lead. role and team_id stay the first of each, for older readers.
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS roles TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS team_ids TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS lead_team_ids TEXT[] NOT NULL DEFAULT '{}';
UPDATE access_invitations SET roles = ARRAY[role] WHERE roles = '{}';
UPDATE access_invitations SET team_ids = ARRAY[team_id] WHERE team_ids = '{}' AND team_id <> '';

-- A team lead who cannot invite for want of a seat asks the owner for one (D71). Nothing is charged without the owner.
CREATE TABLE IF NOT EXISTS seat_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id),
  for_email TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  handled_at BIGINT
);
CREATE INDEX IF NOT EXISTS seat_requests_open ON seat_requests(org_id, created_at DESC) WHERE handled_at IS NULL;
