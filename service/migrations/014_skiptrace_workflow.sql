-- Project-local evidence, with a permanent record of edits and removals.
CREATE TABLE IF NOT EXISTS manual_marks (
    number TEXT PRIMARY KEY,
    mark TEXT NOT NULL,
    at TEXT NOT NULL,
    until_date TEXT,
    source TEXT NOT NULL DEFAULT 'Turf'
);
CREATE TABLE IF NOT EXISTS manual_mark_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT NOT NULL,
    mark TEXT,
    at TEXT NOT NULL,
    until_date TEXT,
    source TEXT NOT NULL
);
-- A scan's reviewed rows are kept with its job, so saving uses the same results.
CREATE TABLE IF NOT EXISTS skiptrace_scan_rows (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    row_number INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    verdict TEXT NOT NULL,
    known_wrong INTEGER NOT NULL,
    do_not_call INTEGER NOT NULL,
    has_callable INTEGER NOT NULL,
    needs_review INTEGER NOT NULL,
    PRIMARY KEY (job_id, row_number)
);
