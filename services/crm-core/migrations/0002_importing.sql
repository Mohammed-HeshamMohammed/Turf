-- List imports: the job queue and the holding tables an upload is loaded into before it becomes leads. The import worker
-- (services/features/importing-lists) has its own database login that may use only this schema and the lead_match view.

CREATE SCHEMA IF NOT EXISTS importing;

CREATE TABLE importing.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  project_id uuid,
  team_id uuid,
  name text NOT NULL,
  filename text NOT NULL,
  size bigint NOT NULL,
  chunk_size int NOT NULL,
  total_chunks int NOT NULL,
  has_header boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'uploading' CHECK (status IN
    ('uploading', 'queued', 'loading', 'mapping', 'cleaning', 'reviewing', 'ready', 'merging', 'done', 'failed', 'cancelled')),
  -- {phase, done, total}: shown as the progress bar
  progress jsonb NOT NULL DEFAULT '{}',
  -- [{idx, header, field, suggested, used, populated, samples}]: what each source column is, for the person to confirm
  columns jsonb NOT NULL DEFAULT '[]',
  -- {rows, exact_duplicates, exact_examples, near_groups, dropped_columns, ...}
  report jsonb NOT NULL DEFAULT '{}',
  error text NOT NULL DEFAULT '',
  loaded_rows bigint NOT NULL DEFAULT 0,
  merged_rows bigint NOT NULL DEFAULT 0,
  worker text,
  heartbeat_at timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_queue ON importing.jobs(created_at) WHERE status IN ('queued', 'loading', 'cleaning');
CREATE INDEX jobs_org ON importing.jobs(org_id, created_at DESC);

CREATE TABLE importing.chunks (
  job_id uuid NOT NULL REFERENCES importing.jobs(id) ON DELETE CASCADE,
  n int NOT NULL,
  size int NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (job_id, n)
);

-- The rows of an upload, as text, exactly as they came. Cleaned values sit beside them; the originals are never changed.
CREATE TABLE importing.rows (
  job_id uuid NOT NULL REFERENCES importing.jobs(id) ON DELETE CASCADE,
  row_no bigint NOT NULL,
  fp bytea NOT NULL,                     -- sha256 of the original cells: identical rows share it
  cells text[] NOT NULL,
  name text, phone text, email text, address text, unit text, city text, region text, zip text, country text,
  latitude double precision, longitude double precision, parcel text, value numeric(14, 2), source text,
  state text NOT NULL DEFAULT 'loaded' CHECK (state IN ('loaded', 'clean', 'near_duplicate', 'skip', 'merge', 'import', 'merged')),
  group_id bigint,                       -- rows that match each other after cleaning share a group
  match_lead uuid,                       -- the existing lead this row matches
  PRIMARY KEY (job_id, row_no)
);
CREATE UNIQUE INDEX rows_fp ON importing.rows(job_id, fp);
CREATE INDEX rows_state ON importing.rows(job_id, state);
CREATE INDEX rows_group ON importing.rows(job_id, group_id) WHERE group_id IS NOT NULL;

-- The view below reads the leads as its owner, whom row security would show nothing. The worker turns this setting on in its
-- own session; it is a login that can read only the view, so the setting opens nothing else. It can never change a lead.
CREATE POLICY matching_read ON leads FOR SELECT USING (current_setting('cw.matching', true) = 'on');
CREATE POLICY matching_read ON properties FOR SELECT USING (current_setting('cw.matching', true) = 'on');

-- Phones compare as digits (a leading 1 on an 11-digit number is dropped), addresses as lower-case letters and digits plus the
-- ZIP. The worker cleans rows with these, and the view below shows leads in the same form, so a repeat is found whatever the spelling.
CREATE FUNCTION importing.norm_phone(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) = 11 AND left(d, 1) = '1' THEN substr(d, 2) WHEN length(d) BETWEEN 7 AND 15 THEN d END
  FROM (SELECT regexp_replace(coalesce(raw, ''), '[^0-9]', '', 'g') AS d) x
$$;
CREATE FUNCTION importing.addr_key(address text, zip text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a ~ '[0-9]' AND a <> '' THEN a || '|' || left(regexp_replace(coalesce(zip, ''), '[^0-9a-zA-Z]', '', 'g'), 5) END
  FROM (SELECT lower(regexp_replace(coalesce(address, ''), '[^0-9a-zA-Z]', '', 'g')) AS a) x
$$;

-- What the worker may read of the leads: just what it needs to find repeats.
CREATE VIEW importing.lead_match AS
  SELECT l.id, l.org_id, l.name, importing.norm_phone(l.phone) AS phone, nullif(lower(btrim(l.email)), '') AS email,
         importing.addr_key(p.address, p.postal_code) AS addr_key
  FROM crm.leads l LEFT JOIN crm.properties p ON p.id = l.property_id
  WHERE l.deleted_at IS NULL;
