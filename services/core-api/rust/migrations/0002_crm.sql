-- Canonical CRM records (plan 2.5). Every table carries org_id under row security; mutable records carry a version.

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  -- Qualification fields a caller must supply before a handoff (plan 3.3), e.g. ["timeline", "condition"].
  qualification_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Imported lists. Original rows stay immutable; a new import is a new version (plan 2.5).
CREATE TABLE datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  name text NOT NULL,
  version int NOT NULL DEFAULT 1,
  artifact_sha256 text,
  legacy_id text,
  row_count int NOT NULL DEFAULT 0,
  mapping jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'Imported',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_rows (
  org_id uuid NOT NULL,
  dataset_id uuid NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  row_number int NOT NULL,
  raw jsonb NOT NULL,
  PRIMARY KEY (dataset_id, row_number)
);

CREATE TABLE contacts (                       -- people or organizations who own property
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'person' CHECK (kind IN ('person', 'organization')),
  name text NOT NULL,
  phones text[] NOT NULL DEFAULT '{}',
  emails text[] NOT NULL DEFAULT '{}',
  mailing_address jsonb,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  address text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  postal_code text NOT NULL DEFAULT '',
  country text NOT NULL DEFAULT '',
  parcel text NOT NULL DEFAULT '',
  -- Supplied coordinates are unverified source evidence (plan 5.5).
  latitude double precision CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision CHECK (longitude BETWEEN -180 AND 180),
  location_source text NOT NULL DEFAULT 'none' CHECK (location_source IN ('none', 'supplied', 'approximate', 'geocoded')),
  details jsonb NOT NULL DEFAULT '{}',
  version int NOT NULL DEFAULT 1,
  CHECK ((latitude IS NULL) = (longitude IS NULL))
);

-- One owner may own several properties; ownership changes over time.
CREATE TABLE ownerships (
  org_id uuid NOT NULL,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  since date,
  until date,
  PRIMARY KEY (property_id, contact_id)
);

CREATE TABLE leads (                          -- an outreach relationship
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  property_id uuid REFERENCES properties(id) ON DELETE SET NULL,
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT 'New',
  verdict text NOT NULL DEFAULT 'Unverified',
  -- Separate contact quality from permission to contact (plan 3.2).
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
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_scope ON leads(org_id, assignee_id, team_id) WHERE deleted_at IS NULL;

-- The same lead may appear in several source lists; legacy keys stay as aliases (plan 2.5).
CREATE TABLE lead_sources (
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  dataset_id uuid REFERENCES datasets(id) ON DELETE CASCADE,
  row_number int,
  legacy_key text,
  PRIMARY KEY (lead_id, dataset_id, row_number)
);
CREATE UNIQUE INDEX lead_sources_legacy ON lead_sources(org_id, legacy_key) WHERE legacy_key IS NOT NULL;

CREATE TABLE lead_shares (                    -- explicitly shared with an external client organization member
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, user_id)
);

CREATE TABLE assignments (                    -- assignment history with reasons
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user uuid REFERENCES users(id),
  to_user uuid REFERENCES users(id),
  reason text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user uuid NOT NULL REFERENCES users(id),
  to_user uuid NOT NULL REFERENCES users(id),
  note text NOT NULL,
  status text NOT NULL DEFAULT 'Requested' CHECK (status IN ('Requested', 'Accepted', 'Declined', 'Cancelled', 'Overdue')),
  due_at timestamptz,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1
);
-- At most one open handoff per lead: duplicate requests and double acceptance cannot both win.
CREATE UNIQUE INDEX handoffs_one_open ON handoffs(lead_id) WHERE status = 'Requested';

CREATE TABLE deals (                          -- a specific transaction
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
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL,
  type text NOT NULL DEFAULT 'Task',
  priority text NOT NULL DEFAULT 'Normal',
  due_at timestamptz,
  timezone text,
  recurrence text,                            -- RFC 5545 RRULE, e.g. FREQ=WEEKLY;BYDAY=MO
  shared_external boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_due ON tasks(org_id, assignee_id, due_at) WHERE done_at IS NULL;

CREATE TABLE notes (                          -- append-only; offline duplicates are removed by operation id
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  author_label text NOT NULL DEFAULT '',
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'shared')),
  mentions uuid[] NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),  -- the client's claimed time
  received_at timestamptz NOT NULL DEFAULT now(),  -- the server's time
  operation_id uuid UNIQUE
);

CREATE TABLE call_events (                    -- manual or dialer call outcomes; append-only
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES users(id),
  agent_label text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  outcome text NOT NULL,
  code text NOT NULL DEFAULT '',
  meaning text NOT NULL CHECK (meaning IN ('reached', 'voicemail', 'no_answer', 'wrong_number', 'wrong_person', 'disconnected', 'do_not_call')),
  scheduled_at timestamptz,
  source text NOT NULL DEFAULT 'manual',      -- manual, readymode, twilio, legacy
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  operation_id uuid UNIQUE
);
CREATE INDEX call_events_lead ON call_events(lead_id, occurred_at);

CREATE TABLE followers (
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, user_id)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  text text NOT NULL,
  entity text,
  entity_id uuid,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Audit events: actor, server time, before/after values and the originating operation (plan 2.5).
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
