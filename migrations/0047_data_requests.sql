-- Build step 44: a lead's request about their data (D310, D367). The owner enters it; Caller Whale finds every record about the person
-- in the agency by their number and email, exports or deletes it, blocks the number if asked, and keeps the request and its dates.
CREATE TABLE data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('access', 'delete')),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 200),    -- emptied once the person's data is deleted
  phone_key text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',                               -- lower case
  received_on date NOT NULL,                                    -- when the person asked
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  block_calls boolean NOT NULL DEFAULT false,
  block_texts boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'exported', 'deleted', 'closed')),
  found jsonb NOT NULL DEFAULT '{}',                            -- how many records of each kind were found, and later deleted
  entered_by uuid NOT NULL,
  entered_at timestamptz NOT NULL DEFAULT now(),
  exported_at timestamptz,
  deleted_by uuid,
  deleted_at timestamptz,
  dialer_erased_at timestamptz,                                 -- the dialer removed its calls and texts with the number
  CHECK (phone_key <> '' OR email <> '')
);
CREATE INDEX data_requests_org ON data_requests (org_id, entered_at DESC);
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON data_requests USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());

-- The dialer's to-do list across agencies: numbers whose calls and texts it must remove.
CREATE TABLE dialer_erasures (
  request_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  phone_key text NOT NULL,
  asked_at timestamptz NOT NULL DEFAULT now()
);
