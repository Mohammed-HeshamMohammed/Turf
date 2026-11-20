-- Build step 32: overviews by role and scheduled reports.
--   * The days each member was active in an agency, for the owner's view of unused seats: their last day and days active this month
--     (D267). Nothing else about them is tracked.
--   * Weekly or monthly reports, scheduled by the owner, admins or a team's leads, to themselves or to a client's people: the email holds
--     totals only and the details open in Caller Whale (D227); periods are days in the agency's time zone (D228); a client sees its deal
--     count and total value, never one deal's figures (D281).

CREATE TABLE member_days (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  day date NOT NULL,
  PRIMARY KEY (org_id, user_id, day)
);

CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  created_by uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('weekly', 'monthly')),
  team_id uuid,                            -- one team's numbers; NULL: the agency's (or the client's)
  client_id uuid REFERENCES clients(id),   -- one client's work
  to_client boolean NOT NULL DEFAULT false, -- sent to the client's people instead of the one who made it
  next_at timestamptz NOT NULL,
  last_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT to_client OR client_id IS NOT NULL)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_days', 'report_schedules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;

-- Which reports are due, across agencies, for the sending loop (no lead or report data here).
CREATE TABLE report_due (
  schedule_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  next_at timestamptz NOT NULL
);
CREATE INDEX report_due_next ON report_due (next_at);
