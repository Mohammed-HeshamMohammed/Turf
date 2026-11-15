-- Merging repeats field by field (imports.go importDecide "picks"): the person chooses, for each field, which row's value the lead keeps.
-- chosen holds the values that replace what a matched lead already has; the merge writes them once (chosen_applied).
ALTER TABLE importing.rows ADD COLUMN IF NOT EXISTS chosen jsonb;
ALTER TABLE importing.rows ADD COLUMN IF NOT EXISTS chosen_applied boolean NOT NULL DEFAULT false;

-- Co-owners: leads at the same property under different names (siblings, spouses, heirs) stay separate leads, linked to each other.
CREATE TABLE IF NOT EXISTS lead_links (
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  related_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'co_owner' CHECK (kind IN ('co_owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, related_id),
  CHECK (lead_id <> related_id)
);
CREATE INDEX IF NOT EXISTS lead_links_related ON lead_links(related_id);
ALTER TABLE lead_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON lead_links;
CREATE POLICY org_isolation ON lead_links USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());

-- Finding the other leads at an address after a merge reads properties by their address key. That index (properties_addr_key) is built
-- in the background after crm-core starts (db.go lateIndexes): on every property at once it took longer than a deploy may wait.
