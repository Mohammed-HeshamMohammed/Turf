-- Synchronization, durable jobs, the transactional outbox, rules, configuration, reports and communication records.

-- Every operation a client submits, kept so a replay returns the first answer (plan 2.7).
CREATE TABLE operations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid REFERENCES users(id),        -- null for rule actions, which act as the system
  device_id text NOT NULL DEFAULT '',
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('applied', 'rejected', 'conflict')),
  result jsonb NOT NULL DEFAULT '{}',
  claimed_at timestamptz,                     -- the device's clock, informational only
  received_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Committed changes in order, for /sync/pull and cache invalidation. Visibility columns let a pull filter by scope.
CREATE TABLE change_log (
  seq bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  lead_id uuid,                               -- the lead whose visibility governs this change
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_log_org ON change_log(org_id, seq);

-- Events for workers and WebSocket fan-out. Written in the same transaction as the change (plan 2.2).
CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL,                         -- lead.stage_changed, handoff.requested, task.overdue, call.recorded, ...
  entity text NOT NULL,
  entity_id uuid NOT NULL,
  lead_id uuid,
  payload jsonb NOT NULL DEFAULT '{}',
  depth int NOT NULL DEFAULT 0,               -- how many rule actions led here; bounds loops
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_until timestamptz,
  processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events(id) WHERE processed_at IS NULL;

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  kind text NOT NULL,                         -- skiptrace, import, export, report, match, media, transcribe, workflow
  queue text NOT NULL DEFAULT 'default',
  input jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress real NOT NULL DEFAULT 0,
  message text NOT NULL DEFAULT '',
  output jsonb,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  lease_owner text,
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id),
  run_after timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_ready ON jobs(queue, run_after) WHERE status = 'queued';

CREATE TABLE rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL,
  version int NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  trigger text NOT NULL,                      -- the outbox kind it listens to
  conditions jsonb NOT NULL DEFAULT '[]',     -- [{"field": "stage", "op": "eq", "value": "Qualified"}]
  actions jsonb NOT NULL DEFAULT '[]',        -- [{"type": "create_task", "title": "...", "due_in_hours": 48}]
  created_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rule_runs (                      -- execution history; the unique key makes a rule idempotent per event
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  rule_id uuid NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  rule_version int NOT NULL,
  event_id bigint NOT NULL,
  dry_run boolean NOT NULL DEFAULT false,
  matched boolean NOT NULL,
  actions jsonb NOT NULL DEFAULT '[]',
  error text,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, rule_version, event_id, dry_run)
);

CREATE TABLE settings_versions (              -- versioned configuration: pipeline, qualification, scripts, layouts
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  actor_id uuid REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX settings_latest ON settings_versions(org_id, key, id DESC);

CREATE TABLE templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'script')),
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  body text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1
);

CREATE TABLE saved_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  kind text NOT NULL,                         -- outcomes, sources, pipeline, aging, workload
  filters jsonb NOT NULL DEFAULT '{}',
  schedule text,                              -- daily, weekly, monthly
  format text NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'pdf')),
  last_sent_at timestamptz
);

-- Content-addressed files: imports, attachments, recordings, generated reports.
CREATE TABLE artifacts (
  sha256 text NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL,
  media_type text NOT NULL,
  size bigint NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  visibility text NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'shared')),
  uploaded_by uuid REFERENCES users(id),
  complete boolean NOT NULL DEFAULT false,    -- a partial upload never becomes visible
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, sha256)
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'internal')),
  subject text NOT NULL DEFAULT '',
  shared_external boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  author_id uuid REFERENCES users(id),
  author_label text NOT NULL DEFAULT '',
  body text NOT NULL,
  -- draft -> queued -> sent -> delivered | failed; 'unknown' when the provider's acceptance is uncertain (never retried blindly).
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'sent', 'delivered', 'failed', 'unknown', 'received')),
  provider text,
  provider_id text,
  scheduled_at timestamptz,
  error text,
  operation_id uuid UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX messages_provider ON messages(provider, provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE suppressions (                   -- opt-outs and do-not-contact, checked before every send or call
  org_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email', 'voice', 'all')),
  address text NOT NULL,
  reason text NOT NULL DEFAULT '',
  until date,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, channel, address)
);

CREATE TABLE call_sessions (                  -- integrated voice, filled in the communication milestone
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES users(id),
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider text,
  provider_id text,
  status text NOT NULL DEFAULT 'initiated',
  recording_sha256 text,
  transcript text,
  transcript_reviewed boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE provider_events (                -- webhook deduplication
  provider text NOT NULL,
  event_id text NOT NULL,
  org_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE integrations (                   -- encrypted provider credentials; 'not configured' until present
  org_id uuid NOT NULL,
  provider text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  secret_ciphertext bytea,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, provider)
);

-- Row security: one policy per business table, organization isolation only. Team, assignment and sharing checks are
-- application checks (plan 2.4). The owning role is not subject to it (no FORCE), so the claim functions below and
-- migrations work; turf_app, the API's role, always is.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams', 'roles', 'projects', 'datasets', 'source_rows', 'contacts', 'properties', 'ownerships', 'leads',
    'lead_sources', 'lead_shares', 'assignments', 'handoffs', 'deals', 'tasks', 'notes', 'call_events', 'followers', 'notifications',
    'audit_events', 'operations', 'change_log', 'outbox_events', 'jobs', 'rules', 'rule_runs', 'settings_versions', 'templates',
    'saved_reports', 'artifacts', 'conversations', 'messages', 'suppressions', 'call_sessions', 'integrations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = turf_org()) WITH CHECK (org_id = turf_org())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO turf_app', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON provider_events TO turf_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO turf_app;

-- Workers claim across organizations through the API's internal routes, which set the organization per job. The
-- claim functions run as the owner so a claim can find work before an organization is known.
CREATE OR REPLACE FUNCTION turf_claim_job(p_queues text[], p_worker text, p_lease_seconds int)
RETURNS TABLE (id uuid, org_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE jobs SET status = 'running', lease_owner = p_worker, lease_until = now() + make_interval(secs => p_lease_seconds),
                  attempts = attempts + 1
  WHERE jobs.id = (
    SELECT j.id FROM jobs j
    WHERE (j.status = 'queued' AND j.run_after <= now() AND j.queue = ANY(p_queues))
       OR (j.status = 'running' AND j.lease_until < now() AND j.queue = ANY(p_queues) AND j.attempts < j.max_attempts)
    ORDER BY j.run_after, j.created_at FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING jobs.id, jobs.org_id
$$;

CREATE OR REPLACE FUNCTION turf_claim_events(p_worker text, p_limit int, p_lease_seconds int)
RETURNS TABLE (id bigint, org_id uuid) LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events SET claimed_by = p_worker, claimed_until = now() + make_interval(secs => p_lease_seconds)
  WHERE outbox_events.id IN (
    SELECT e.id FROM outbox_events e
    WHERE e.processed_at IS NULL AND (e.claimed_until IS NULL OR e.claimed_until < now())
    ORDER BY e.id FOR UPDATE SKIP LOCKED LIMIT p_limit)
  RETURNING outbox_events.id, outbox_events.org_id
$$;

REVOKE ALL ON FUNCTION turf_claim_job(text[], text, int), turf_claim_events(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION turf_claim_job(text[], text, int), turf_claim_events(text, int, int) TO turf_app;
