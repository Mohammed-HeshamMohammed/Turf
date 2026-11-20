-- Find a completed import's identical source row without scanning every stored row.
CREATE INDEX rows_imported_fingerprint ON importing.rows (fp) WHERE lead_id IS NOT NULL;
