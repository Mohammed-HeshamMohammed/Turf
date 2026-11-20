-- Build step 27: commission tracking, optional per agency (D144, D149). The owner switches it on and sets the rules per role or per
-- person: a fixed amount per appointment set (a call logged "Transfer") and a percentage of a won deal (its fee, else its amount); when a
-- caller set up the deal a closer won, the agency's split gives the caller part of the deal's commission. The owner can override any
-- figure, with a reason. Caller Whale shows what each person earned; no payment is made through it.

ALTER TABLE orgs ADD COLUMN commissions_on boolean NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN commission_split numeric(5,2) NOT NULL DEFAULT 0 CHECK (commission_split BETWEEN 0 AND 100); -- the caller's share, percent

-- Who won a deal and when, for the closer's commission.
ALTER TABLE deals ADD COLUMN closed_at timestamptz;
ALTER TABLE deals ADD COLUMN closed_by uuid;

CREATE TABLE commission_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  role text,                            -- a workspace role (caller, closer, ...), or
  user_id uuid,                         -- one person, which comes before their role
  per_appointment numeric(12,2) NOT NULL DEFAULT 0 CHECK (per_appointment >= 0),
  deal_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (deal_percent BETWEEN 0 AND 100),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((role IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX commission_rules_role ON commission_rules (org_id, role) WHERE role IS NOT NULL;
CREATE UNIQUE INDEX commission_rules_person ON commission_rules (org_id, user_id) WHERE user_id IS NOT NULL;

-- The owner's own figure for one item of one person's earnings.
CREATE TABLE commission_overrides (
  org_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('appointment', 'deal')),
  source_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  set_by uuid NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, source, source_id, user_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commission_rules', 'commission_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
