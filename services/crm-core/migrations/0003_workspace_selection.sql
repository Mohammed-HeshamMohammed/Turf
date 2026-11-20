-- The last workspace chosen by each person, shared across their devices.
ALTER TABLE people ADD COLUMN last_org_id uuid REFERENCES orgs(id) ON DELETE SET NULL;
ALTER TABLE people ADD COLUMN last_org_at timestamptz;
