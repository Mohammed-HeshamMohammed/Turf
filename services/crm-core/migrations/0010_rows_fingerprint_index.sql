-- Finding rows that were already imported (same fingerprint, already linked to a lead) scanned every holding row of every import. This
-- index lets it look the fingerprints up instead.
CREATE INDEX IF NOT EXISTS rows_fp_linked ON importing.rows (fp) WHERE lead_id IS NOT NULL;
