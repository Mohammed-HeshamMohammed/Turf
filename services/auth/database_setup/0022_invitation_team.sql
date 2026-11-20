-- A caller or closer is invited straight into a team (authz_teams), so they land under that team's manager.
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS team_id TEXT NOT NULL DEFAULT '';
