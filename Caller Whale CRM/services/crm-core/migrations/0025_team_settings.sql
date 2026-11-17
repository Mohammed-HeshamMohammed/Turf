-- Each team's own settings (build step 20), changed by its team leads, an admin or the owner (D348):
--   agents_claim  whether its callers, closers and researchers may claim the team's unassigned leads themselves (D111);
--                 its leads and deputies hand them out either way.
--   open_limit    the most open leads one agent may hold before claiming more (D183); null: no limit.
--   leaderboard   whether the team's agents see each other's numbers (D125); without it each sees only their own.
-- A team with no row has the defaults.
CREATE TABLE IF NOT EXISTS team_settings (
  team_id uuid PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  agents_claim boolean NOT NULL DEFAULT false,
  open_limit integer CHECK (open_limit IS NULL OR open_limit BETWEEN 1 AND 100000),
  leaderboard boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE team_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON team_settings;
CREATE POLICY org_isolation ON team_settings USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());

-- The unassigned leads of a team, for handing out and claiming.
CREATE INDEX IF NOT EXISTS leads_team_pool ON leads(org_id, team_id, created_at) WHERE assignee_id IS NULL AND deleted_at IS NULL AND archived_at IS NULL;
