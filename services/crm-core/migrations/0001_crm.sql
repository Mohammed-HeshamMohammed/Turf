-- The CRM records. Every table carries org_id and is under row security: a request sees only the workspace named in
-- its transaction settings (cw.org_id), whatever a query forgets to say. Identity lives in auth, roles in authz.

CREATE TABLE orgs (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (                         -- display names of people who have used the CRM (auth owns the account)
  user_id uuid PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  UNIQUE (org_id, name)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  qualification_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  address text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  parcel text NOT NULL DEFAULT '',
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  location_source text NOT NULL DEFAULT 'none' CHECK (location_source IN ('none', 'supplied', 'approximate', 'geocoded')),
  details jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  assignee_id uuid,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT 'New',
  verdict text NOT NULL DEFAULT 'Unverified',
  do_not_call boolean NOT NULL DEFAULT false,
  next_action text NOT NULL DEFAULT '',
  next_action_at timestamptz,
  next_action_tz text,
  priority text NOT NULL DEFAULT 'Normal',
  source text NOT NULL DEFAULT '',
  value_amount numeric(14, 2),
  value_currency char(3),
  qualification jsonb NOT NULL DEFAULT '{}',
  shared_external boolean NOT NULL DEFAULT false,
  sent_to text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_scope ON leads(org_id, assignee_id, team_id) WHERE deleted_at IS NULL;
CREATE INDEX leads_phone ON leads(org_id, phone) WHERE phone <> '';
CREATE INDEX leads_email ON leads(org_id, lower(email)) WHERE email <> '';

CREATE TABLE lead_shares (
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  PRIMARY KEY (lead_id, user_id)
);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user uuid,
  to_user uuid,
  reason text NOT NULL DEFAULT '',
  actor_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user uuid NOT NULL,
  to_user uuid NOT NULL,
  note text NOT NULL,
  status text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested', 'Accepted', 'Declined', 'Cancelled', 'Overdue')),
  due_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX handoffs_one_open ON handoffs(lead_id) WHERE status = 'Requested';

CREATE TABLE deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  stage text NOT NULL DEFAULT 'Qualified',
  amount numeric(14, 2),
  fee numeric(14, 2),
  currency char(3) NOT NULL DEFAULT 'USD',
  close_date date,
  outcome_reason text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX deals_one_per_lead ON deals(lead_id);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  deal_id uuid REFERENCES deals(id) ON DELETE CASCADE,
  assignee_id uuid,
  title text NOT NULL,
  type text NOT NULL DEFAULT 'Task',
  priority text NOT NULL DEFAULT 'Normal',
  due_at timestamptz,
  timezone text,
  recurrence text,
  shared_external boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id uuid,
  author_label text NOT NULL DEFAULT '',
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'shared')),
  mentions uuid[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  operation_id uuid UNIQUE
);

CREATE TABLE call_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id uuid,
  agent_label text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  outcome text NOT NULL,
  code text NOT NULL DEFAULT '',
  meaning text NOT NULL CHECK (meaning IN ('reached', 'voicemail', 'no_answer', 'wrong_number', 'wrong_person', 'disconnected', 'do_not_call')),
  scheduled_at timestamptz,
  source text NOT NULL DEFAULT 'manual',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  operation_id uuid UNIQUE
);
CREATE INDEX call_events_lead ON call_events(lead_id, occurred_at);

-- Every operation a device sends, kept with its answer: a replay returns the first answer.
CREATE TABLE operations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  device_id text NOT NULL DEFAULT '',
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'applied',
  result jsonb,
  claimed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- What pull reads: one row per change, per workspace, in order.
CREATE TABLE change_log (
  seq bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  lead_id uuid,
  op text NOT NULL CHECK (op IN ('upsert', 'delete'))
);
CREATE INDEX change_log_org ON change_log(org_id, seq);

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  actor_id uuid,
  actor_label text NOT NULL DEFAULT '',
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  before jsonb,
  after jsonb,
  operation_id uuid,
  occurred_at timestamptz,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity ON audit_events(org_id, entity, entity_id, id);

-- The request workspace and person, set at the start of every transaction.
CREATE FUNCTION cw_org() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cw.org_id', true), '')::uuid $$;
CREATE FUNCTION cw_uuids(name text) RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting(name, true), '')::uuid[], '{}') $$;
CREATE FUNCTION cw_external() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('cw.scopes', true), '') = 'shared' $$;

-- Record scope: which leads this person sees (organization, team, project, own, shared).
CREATE FUNCTION cw_visible_lead(p_lead uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT nullif(current_setting('cw.user_id', true), '')::uuid AS id,
           string_to_array(coalesce(current_setting('cw.scopes', true), ''), ',') AS scopes
  )
  SELECT EXISTS (
    SELECT 1 FROM leads l, me
    WHERE l.id = p_lead AND l.deleted_at IS NULL AND l.org_id = cw_org() AND (
         'organization' = ANY(me.scopes)
      OR ('team' = ANY(me.scopes) AND l.team_id = ANY(cw_uuids('cw.team_ids')))
      OR ('project' = ANY(me.scopes) AND l.project_id = ANY(cw_uuids('cw.project_ids')))
      OR ('own' = ANY(me.scopes) AND (l.assignee_id = me.id
           OR EXISTS (SELECT 1 FROM handoffs h WHERE h.lead_id = l.id AND h.to_user = me.id AND h.status = 'Requested')))
      OR ('shared' = ANY(me.scopes) AND EXISTS (SELECT 1 FROM lead_shares s WHERE s.lead_id = l.id AND s.user_id = me.id))
    )
  )
$$;

-- Row security on every workspace table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams','projects','properties','leads','lead_shares','assignments','handoffs','deals','tasks','notes','call_events','operations','change_log','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
