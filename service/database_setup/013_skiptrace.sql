-- Skip Tracing: how each dataset's phone columns and call outcomes are read. Kept per dataset so the same setup applies
-- the next time, and so call outcomes in one file can warn about numbers in another.
CREATE TABLE IF NOT EXISTS skiptrace_settings (
    dataset_id TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE,
    config_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
