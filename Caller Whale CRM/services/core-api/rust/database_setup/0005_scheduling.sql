-- Scheduler bookkeeping: each overdue task and handoff produces its event once.
ALTER TABLE tasks ADD COLUMN overdue_emitted_at timestamptz;
ALTER TABLE handoffs ADD COLUMN overdue_emitted_at timestamptz;
CREATE INDEX tasks_overdue_pending ON tasks(due_at) WHERE done_at IS NULL AND overdue_emitted_at IS NULL;

-- Assignment rotation for round-robin rules.
CREATE TABLE assignment_cursors (
  org_id uuid NOT NULL,
  key text NOT NULL,
  last_user uuid,
  PRIMARY KEY (org_id, key)
);
ALTER TABLE assignment_cursors ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON assignment_cursors USING (org_id = callerwhale_org()) WITH CHECK (org_id = callerwhale_org());
GRANT SELECT, INSERT, UPDATE, DELETE ON assignment_cursors TO callerwhale_app;

-- The scheduler finds organizations with due work before acting inside each one.
CREATE OR REPLACE FUNCTION callerwhale_orgs_with_due_work() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT org_id FROM tasks WHERE done_at IS NULL AND overdue_emitted_at IS NULL AND due_at < now()
  UNION SELECT DISTINCT org_id FROM handoffs WHERE status = 'Requested' AND overdue_emitted_at IS NULL AND due_at < now()
  UNION SELECT DISTINCT org_id FROM saved_reports WHERE schedule IS NOT NULL
$$;
REVOKE ALL ON FUNCTION callerwhale_orgs_with_due_work() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION callerwhale_orgs_with_due_work() TO callerwhale_app;
