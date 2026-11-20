-- Files on a lead (contracts, photos, documents), uploaded in the CRM and kept here with who uploaded them and when. Internal files
-- stay with the team; shared ones are seen by the clients a lead is shared with. At most 10 MB each (files.go).
CREATE TABLE IF NOT EXISTS lead_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  name text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'shared')),
  uploaded_by uuid NOT NULL,
  uploaded_label text NOT NULL DEFAULT '',
  body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lead_files_lead ON lead_files(lead_id, created_at DESC);
ALTER TABLE lead_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_isolation ON lead_files;
CREATE POLICY org_isolation ON lead_files USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());
