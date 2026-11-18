-- Build step 33: keys for outside tools and outgoing events.
--   * The owner or an admin makes a key for one outside tool, limited to what it needs: adding leads to one team (and one list, so one
--     client's work), and reading leads or deals there. A key can be switched off, each use is recorded, and nothing a key reaches can
--     spend money: no calls, texts, budgets or plans (D233). Only a hash of the key is kept; the key is shown once.
--   * The owner chooses events (a lead booked, a deal won) to send to an https address of theirs. Each message holds only the event, an
--     id and the time, signed; details are fetched with a key, so nothing personal travels unasked (D234).

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL CHECK (scopes <@ ARRAY['leads:add', 'leads:read', 'deals:read'] AND cardinality(scopes) >= 1),
  team_id uuid,
  project_id uuid REFERENCES projects(id),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  off_at timestamptz,
  last_used_at timestamptz,
  uses bigint NOT NULL DEFAULT 0
);

CREATE TABLE api_key_uses (
  org_id uuid NOT NULL,
  key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  action text NOT NULL,
  items int NOT NULL DEFAULT 1,
  status int NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_key_uses_key ON api_key_uses (key_id, at);

CREATE TABLE event_hooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  url text NOT NULL CHECK (url ~ '^https://'),
  events text[] NOT NULL CHECK (events <@ ARRAY['lead.booked', 'deal.won'] AND cardinality(events) >= 1),
  secret text NOT NULL,                   -- signs each message (HMAC-SHA256); shown once
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  off_at timestamptz
);

CREATE TABLE event_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  hook_id uuid NOT NULL REFERENCES event_hooks(id) ON DELETE CASCADE,
  body jsonb NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  last_status int,
  delivered_at timestamptz,
  given_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX event_deliveries_hook ON event_deliveries (hook_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'api_key_uses', 'event_hooks', 'event_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;

-- Deliveries due, across agencies, for the sending loop (ids only).
CREATE TABLE event_due (
  delivery_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  next_at timestamptz NOT NULL
);
CREATE INDEX event_due_next ON event_due (next_at);
