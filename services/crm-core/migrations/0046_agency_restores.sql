-- Build step 41: restoring one agency's data from a backup (D297, D370). Staff ask, the agency's owner confirms, staff run it; each
-- step is kept. Kept outside the agencies' rows so staff see every request.
CREATE TABLE agency_restores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  backup_date date NOT NULL,                  -- the day of the backup staff put in the restore copy
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'waiting_owner' CHECK (status IN ('waiting_owner', 'confirmed', 'done', 'failed', 'cancelled')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  ran_by uuid,
  ran_at timestamptz,
  report jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX agency_restores_org ON agency_restores (org_id, requested_at DESC);

-- After a restore every device of the agency starts over with a fresh copy: a pull from before this point is told to reset.
CREATE TABLE org_resets (
  org_id uuid NOT NULL,
  seq bigint NOT NULL,                        -- a change_log row written at the restore
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, seq)
);
ALTER TABLE org_resets ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_resets FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON org_resets USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());
