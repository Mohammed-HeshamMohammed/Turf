-- Turf's own. What happened to a lead, in order: its stage changed, a callback was set or cleared. Calls and notes
-- have their own tables (phone_outcomes, lead_notes) and are read beside this one.
CREATE TABLE IF NOT EXISTS lead_events (
    id TEXT PRIMARY KEY,
    lead_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    at TEXT NOT NULL,
    dataset_id TEXT,
    row_number INTEGER
);
CREATE INDEX IF NOT EXISTS idx_lead_events_key ON lead_events(lead_key, at);
CREATE INDEX IF NOT EXISTS idx_lead_events_at ON lead_events(at);
