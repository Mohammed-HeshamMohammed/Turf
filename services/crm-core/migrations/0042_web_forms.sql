-- Build step 36: website forms (D247). The owner or an admin makes a form for a client (none: the agency's own business), sending its
-- leads to a chosen team. It is a public link that can also be embedded on the client's or agency's site. Each submission becomes an
-- unassigned lead of that client in that team, is checked against the block lists (a blocked number comes in as do-not-call, and the
-- submission says so), and records whether the person ticked the consent and the exact words they agreed to, which is consent to text
-- for that client's work (D353, D366). The consent wording is the lawyer's.

CREATE TABLE web_forms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  token text NOT NULL UNIQUE,                    -- the public address: <agency>.<random>
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  title text NOT NULL DEFAULT '' CHECK (length(title) <= 160),
  client_id uuid REFERENCES clients(id),
  team_id uuid NOT NULL,
  consent_text text NOT NULL CHECK (length(consent_text) BETWEEN 20 AND 1000),
  thanks text NOT NULL DEFAULT '' CHECK (length(thanks) <= 500),
  embed_origins text[] NOT NULL DEFAULT '{}',    -- sites that may embed it; empty: any
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  off_at timestamptz
);

CREATE TABLE form_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  form_id uuid NOT NULL REFERENCES web_forms(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  client_id uuid,
  phone_key text,
  consent boolean NOT NULL,
  consent_text text NOT NULL,                    -- the words shown when they agreed
  blocked boolean NOT NULL DEFAULT false,        -- the number was on a block list
  network text NOT NULL DEFAULT '',              -- the sender's address, cut to its first parts
  user_agent text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX form_submissions_form ON form_submissions (form_id, at);
CREATE INDEX form_submissions_consent ON form_submissions (org_id, phone_key) WHERE consent;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['web_forms', 'form_submissions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
