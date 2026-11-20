-- Bulk assignment (assign.go): an agency owner or team manager gives many leads at once (picked leads, everything matching a
-- filter, or the first N of it) to one person or shared evenly between several. The work runs in batches in the background, and
-- this row says how far it got, so it continues after a restart and the screen can follow it.
CREATE TABLE assignment_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL,
  actor_scope jsonb NOT NULL,             -- the asker's record scope when they asked: the run never reaches beyond it
  selection jsonb NOT NULL,               -- {ids, stage, project_id, assignee, team_id}
  targets uuid[] NOT NULL DEFAULT '{}',   -- empty: the leads become unassigned
  target_teams uuid[] NOT NULL DEFAULT '{}', -- each target's team, in the same order (a zero uuid for none)
  limit_n bigint CHECK (limit_n IS NULL OR limit_n > 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  assigned bigint NOT NULL DEFAULT 0,
  cursor_id uuid,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX assignment_runs_org ON assignment_runs(org_id, created_at DESC);
CREATE INDEX assignment_runs_running ON assignment_runs(status) WHERE status = 'running';
ALTER TABLE assignment_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON assignment_runs USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());
