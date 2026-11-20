-- Build step 28, part A: pipeline stages, closers' hours and booking, and deal credit.
--   * The owner or an admin sets the agency's open deal stages, and a client's own when its work needs them; "Closed won" and "Closed
--     lost" always end a deal. Teams and agents never change stages (D154).
--   * A closer keeps their weekly hours; the team's leads, admins and the owner can set them too, and can limit the range a closer's hours
--     must stay inside (D156). A caller of the closer's team sees the free slots and who each is with, and books one: it becomes an
--     appointment task on the closer's list (D155).
--   * A won deal is credited to the caller who set it and the closer who closed it, with the team and the client; commissions read these
--     records (D157). Its lead is marked won and leaves the calling queues (D283).

CREATE TABLE deal_stages (
  org_id uuid NOT NULL,
  client_id uuid REFERENCES clients(id),           -- NULL: the agency's
  stages text[] NOT NULL CHECK (cardinality(stages) BETWEEN 1 AND 15),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deal_stages_one ON deal_stages (org_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

ALTER TABLE orgs ADD COLUMN slot_minutes int NOT NULL DEFAULT 30 CHECK (slot_minutes IN (15, 20, 30, 45, 60, 90));

CREATE TABLE closer_hours (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 is Sunday
  from_minute int NOT NULL CHECK (from_minute BETWEEN 0 AND 1439),
  until_minute int NOT NULL CHECK (until_minute BETWEEN 1 AND 1440),
  set_by uuid,
  PRIMARY KEY (org_id, user_id, weekday),
  CHECK (until_minute > from_minute)
);

CREATE TABLE closer_limits (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  from_minute int NOT NULL CHECK (from_minute BETWEEN 0 AND 1439),
  until_minute int NOT NULL CHECK (until_minute BETWEEN 1 AND 1440),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id),
  CHECK (until_minute > from_minute)
);

CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  closer_id uuid NOT NULL,
  booked_by uuid NOT NULL,
  team_id uuid,
  client_id uuid,
  task_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'cancelled', 'done')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX appointments_closer ON appointments (org_id, closer_id, starts_at) WHERE status = 'booked';
CREATE INDEX appointments_lead ON appointments (lead_id, created_at);

CREATE TABLE deal_credits (
  org_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('caller', 'closer')),
  team_id uuid,
  client_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deal_id, role)
);
CREATE INDEX deal_credits_person ON deal_credits (org_id, user_id, at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['deal_stages', 'closer_hours', 'closer_limits', 'appointments', 'deal_credits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
