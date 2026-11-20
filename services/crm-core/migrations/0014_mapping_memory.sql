-- What a workspace decided a column heading was, so the next list with that heading arrives already answered.
-- Written by crm-core when the person confirms the columns; read by the import worker. Headings are not personal data.
CREATE TABLE IF NOT EXISTS importing.mapping_memory (
  org_id uuid NOT NULL,
  header_key text NOT NULL,
  field text,
  used boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, header_key)
);
