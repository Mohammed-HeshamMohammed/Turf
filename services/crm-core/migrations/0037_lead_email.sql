-- Build step 29: email to leads from the agency's or a client's own domain (D161, D319), through Amazon SES.
--   * The owner or an admin adds a sending domain and puts its DKIM records in their DNS; email goes only from a verified one, the lead's
--     client's when it has one, else the agency's.
--   * Every email carries the agency's postal address and an unsubscribe link (one click, also in the List-Unsubscribe header);
--     unsubscribing blocks email to that address for the whole agency (D317). Link clicks are recorded on the lead; opens are not (D316).
--   * Replies go to a Caller Whale reply address, come in through SES and SNS, and land on the lead's record; one left unanswered tells
--     the team's leads, as an unanswered text does (D318).
-- Public tokens (links, unsubscribe, replies) carry their agency's id, so the open routes can enter that agency's rows.

ALTER TABLE orgs ADD COLUMN postal_address text NOT NULL DEFAULT '' CHECK (length(postal_address) <= 300);

CREATE TABLE sending_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  client_id uuid REFERENCES clients(id),   -- NULL: the agency's own
  domain text NOT NULL CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  from_local text NOT NULL DEFAULT 'team' CHECK (from_local ~ '^[a-z0-9._-]{1,40}$'),
  records jsonb NOT NULL DEFAULT '[]',    -- the DNS records to add
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);
CREATE UNIQUE INDEX sending_domains_domain ON sending_domains (domain);   -- one agency per domain, across Caller Whale
CREATE UNIQUE INDEX sending_domains_one ON sending_domains (org_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE lead_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id uuid,
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  from_addr text NOT NULL,
  to_addr text NOT NULL,
  subject text NOT NULL DEFAULT '' CHECK (length(subject) <= 300),
  body text NOT NULL CHECK (length(body) <= 100000),
  reply_token text UNIQUE,
  provider_id text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'received')),
  waiting boolean NOT NULL DEFAULT false,   -- an incoming email nobody answered yet
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_emails_lead ON lead_emails (lead_id, created_at);

CREATE TABLE email_links (
  token text PRIMARY KEY,
  org_id uuid NOT NULL,
  email_id uuid NOT NULL REFERENCES lead_emails(id) ON DELETE CASCADE,
  lead_id uuid NOT NULL,
  url text NOT NULL,
  clicks int NOT NULL DEFAULT 0,
  first_click_at timestamptz,
  last_click_at timestamptz
);

CREATE TABLE email_unsubscribes (
  org_id uuid NOT NULL,
  address text NOT NULL,                   -- lower case
  at timestamptz NOT NULL DEFAULT now(),
  email_id uuid,
  PRIMARY KEY (org_id, address)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sending_domains', 'lead_emails', 'email_links', 'email_unsubscribes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;

-- Replies waiting for an answer, across agencies, for the minute check that tells the team's leads (no lead data here).
CREATE TABLE email_waits (
  email_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  due_at timestamptz NOT NULL
);
CREATE INDEX email_waits_due ON email_waits (due_at);
