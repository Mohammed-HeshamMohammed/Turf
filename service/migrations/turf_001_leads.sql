-- Turf's own tables. The name sorts after DataForge's numbered migrations and can never collide with one it adds,
-- so a project still opens in both.

-- Where a lead stands, and when to call it again. A lead is a property (or, without an address, a phone), so what
-- is said about it follows it into every list that holds it.
CREATE TABLE IF NOT EXISTS lead_states (
    lead_key TEXT PRIMARY KEY,
    stage TEXT NOT NULL DEFAULT 'new',
    callback_on TEXT,
    callback_note TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    dataset_id TEXT,
    row_number INTEGER,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_states_callback ON lead_states(callback_on);

-- Notes on a lead. A removed note stays, marked, as every other record of the project does.
CREATE TABLE IF NOT EXISTS lead_notes (
    id TEXT PRIMARY KEY,
    lead_key TEXT NOT NULL,
    note TEXT NOT NULL,
    at TEXT NOT NULL,
    dataset_id TEXT,
    row_number INTEGER,
    removed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lead_notes_key ON lead_notes(lead_key, at);

-- Lists the person deleted, kept for a while so a deletion can be undone.
CREATE TABLE IF NOT EXISTS trashed_datasets (
    dataset_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    deleted_at TEXT NOT NULL
);
