-- assignment_runs forces row security, so the service's background work reads and updates a run inside a transaction set to the run's
-- workspace (assign.go). Continuing runs after a restart must find the running ones in every workspace: this lets a transaction that
-- turns cw.resume on read (never change) them; only resumeAssignments sets it.
DROP POLICY IF EXISTS resume_read ON assignment_runs;
CREATE POLICY resume_read ON assignment_runs FOR SELECT USING (current_setting('cw.resume', true) = 'on');
