-- Step 20, part C.

-- Tags (D230): the owner and admins make agency tags (team_id null), a team's leads make tags for their team; everyone who works a
-- lead applies existing tags to it, and nobody else creates them.
CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color text NOT NULL DEFAULT '' CHECK (length(color) <= 20),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_name ON tags(org_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE TABLE IF NOT EXISTS lead_tags (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX IF NOT EXISTS lead_tags_tag ON lead_tags(tag_id);

-- Merging two copies of one person (D231): what moved from the merged lead to the kept one, so the merge can be undone for 7 days.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS merged_into uuid;
CREATE TABLE IF NOT EXISTS lead_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kept_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  merged_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  moved jsonb NOT NULL DEFAULT '{}',   -- {"notes": [ids], "calls": [...], "tasks": [...], "deals": [...], "handoffs": [...], "tags": [...]}
  kept_before jsonb NOT NULL DEFAULT '{}', -- the kept lead's phone, email and contacts before the merge
  merged_by uuid NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
CREATE INDEX IF NOT EXISTS lead_merges_kept ON lead_merges(kept_id, merged_at DESC);

-- Retention (D224): how long a lead nobody works is kept (null: kept), and the leads the owner chose to keep, with why.
ALTER TABLE orgs ADD COLUMN IF NOT EXISTS keep_days integer CHECK (keep_days IS NULL OR keep_days BETWEEN 30 AND 3650);
CREATE TABLE IF NOT EXISTS lead_keeps (
  lead_id uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  kept_by uuid NOT NULL,
  kept_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tags', 'lead_tags', 'lead_merges', 'lead_keeps'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS org_isolation ON %I', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
