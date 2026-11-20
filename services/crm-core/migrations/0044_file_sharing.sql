-- Build step 38: files on leads (D256-D258, D289). Up to 25 MB, scanned before anyone opens them, shared with clients or by a link
-- that expires, each share recorded and withdrawable, and each opening of a shared file recorded.
ALTER TABLE lead_files DROP CONSTRAINT IF EXISTS lead_files_size_check;
ALTER TABLE lead_files ADD CONSTRAINT lead_files_size_check CHECK (size > 0 AND size <= 26214400);
-- Files from before scanning start as waiting: they are scanned the first time someone lists or opens them.
ALTER TABLE lead_files ADD COLUMN scan text NOT NULL DEFAULT 'waiting' CHECK (scan IN ('waiting', 'clean', 'infected'));
ALTER TABLE lead_files ADD COLUMN scanned_at timestamptz;
ALTER TABLE lead_files ADD COLUMN scan_note text NOT NULL DEFAULT '';

-- Files waiting for the scanner, across agencies, so one loop can retry them; the file itself stays in its agency's rows.
CREATE TABLE file_scans (
  file_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  due_at timestamptz NOT NULL DEFAULT now(),
  tries int NOT NULL DEFAULT 0
);
CREATE INDEX file_scans_due ON file_scans (due_at);

-- Every share: with the lead's clients, or a link for someone outside (a partner, a title company). Withdrawn or expired, it stops.
CREATE TABLE file_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES lead_files(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('clients', 'link')),
  token text UNIQUE,                       -- a link's address; NULL for clients
  recipient text NOT NULL DEFAULT '' CHECK (length(recipient) <= 200),
  expires_at timestamptz,
  created_by uuid NOT NULL,
  created_label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_by uuid,
  withdrawn_at timestamptz
);
CREATE INDEX file_shares_file ON file_shares (file_id, created_at DESC);
ALTER TABLE file_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON file_shares USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());

-- Who opened or downloaded a shared file, and when: a signed-in client by name, a link by its network.
CREATE TABLE file_opens (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES lead_files(id) ON DELETE CASCADE,
  share_id uuid REFERENCES file_shares(id) ON DELETE CASCADE,
  user_id uuid,
  label text NOT NULL DEFAULT '',
  network text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_opens_file ON file_opens (file_id, at DESC);
ALTER TABLE file_opens ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_opens FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON file_opens USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());
