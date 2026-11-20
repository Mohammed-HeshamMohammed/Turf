-- Build step 45: shared learning by agreement (D324-D327). Kept outside the agencies' rows: the daily run finds the agencies that
-- agreed, and staff check each agency's notice to its leads.

-- The owner's separate agreement (not part of the general terms), the agency's notice to leads, and staff's check of that notice.
CREATE TABLE learning_agreements (
  org_id uuid PRIMARY KEY,
  version text NOT NULL,
  signed_by uuid NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT now(),
  notice_url text NOT NULL DEFAULT '' CHECK (length(notice_url) <= 500),   -- where the agency tells its leads
  notice_checked_at timestamptz,                                         -- staff (with the lawyer's guidance) confirmed it covers this use
  notice_checked_by uuid,
  notice_check_note text NOT NULL DEFAULT '' CHECK (length(notice_check_note) <= 1000),
  withdrawn_at timestamptz,
  withdrawn_by uuid
);

-- Each client agrees for its own part (D326): until it does, its leads' calls are left out.
CREATE TABLE client_learning_consents (
  org_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  agreed_by uuid NOT NULL,
  agreed_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  PRIMARY KEY (org_id, client_id)
);
ALTER TABLE client_learning_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_learning_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON client_learning_consents USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());

-- The patterns: counts only, by a fixed kind and bucket. No agency, person, number, address or client is in a row; source is a hash
-- of the agency so its month can be replaced, never shown.
CREATE TABLE shared_patterns (
  month date NOT NULL,
  kind text NOT NULL CHECK (kind IN ('reach_by_hour', 'reach_by_attempt')),
  bucket text NOT NULL CHECK (bucket ~ '^[0-9]{1,2}(:[0-9]{1,2})?$'),
  source text NOT NULL CHECK (source ~ '^[0-9a-f]{64}$'),
  calls int NOT NULL CHECK (calls >= 0),
  reached int NOT NULL CHECK (reached >= 0 AND reached <= calls),
  PRIMARY KEY (month, kind, bucket, source)
);

-- Each contribution and its check, kept.
CREATE TABLE shared_learning_runs (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  month date NOT NULL,
  rows int NOT NULL,
  passed boolean NOT NULL,
  problem text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
