-- Dated phone activity is append-only. Corrections retain the original event.
CREATE TABLE phone_outcomes (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    outcome TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    dataset_id TEXT,
    row_number INTEGER,
    person_key TEXT,
    notes TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'Turf call log',
    retired_at TEXT
);
CREATE INDEX phone_outcomes_number ON phone_outcomes(number, occurred_at);
CREATE TABLE phone_lookups (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL,
    provider TEXT NOT NULL,
    products TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    success INTEGER NOT NULL,
    result_json TEXT NOT NULL,
    estimated_cost TEXT,
    error TEXT
);
CREATE INDEX phone_lookups_number ON phone_lookups(number, checked_at);
