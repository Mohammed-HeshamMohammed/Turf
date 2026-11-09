-- A ReadyMode call export is a history of events, not a list of new leads.
-- Keep its original cells in importing.rows and its interpreted event beside them.
ALTER TABLE importing.jobs ADD COLUMN kind text NOT NULL DEFAULT 'lead_list'
  CHECK (kind IN ('lead_list', 'readymode_calls'));
ALTER TABLE importing.jobs ADD COLUMN source_timezone text NOT NULL DEFAULT 'UTC';
ALTER TABLE importing.jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE importing.jobs ADD CONSTRAINT jobs_status_check CHECK (status IN
  ('uploading', 'queued', 'loading', 'mapping', 'cleaning', 'reviewing', 'ready', 'merging',
   'call_ready', 'call_merging', 'done', 'failed', 'cancelled'));
ALTER TABLE importing.rows ADD COLUMN call_data jsonb;

ALTER TABLE call_events ADD COLUMN import_job_id uuid REFERENCES importing.jobs(id) ON DELETE SET NULL;
ALTER TABLE call_events ADD COLUMN import_row_no bigint;
ALTER TABLE call_events ADD COLUMN source_record_id text NOT NULL DEFAULT '';
ALTER TABLE call_events ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE call_events ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE call_events ADD COLUMN recording_started_at timestamptz;
ALTER TABLE call_events ADD COLUMN recording_ended_at timestamptz;
ALTER TABLE call_events DROP CONSTRAINT call_events_meaning_check;
ALTER TABLE call_events ADD CONSTRAINT call_events_meaning_check CHECK
  (meaning IN ('reached', 'voicemail', 'no_answer', 'wrong_number', 'wrong_person', 'disconnected', 'do_not_call', 'unknown'));
CREATE UNIQUE INDEX call_events_import_row ON call_events(import_job_id, import_row_no)
  WHERE import_job_id IS NOT NULL;
CREATE UNIQUE INDEX call_events_readymode_record ON call_events(org_id, source_record_id, occurred_at, phone)
  WHERE source = 'readymode' AND source_record_id <> '';
