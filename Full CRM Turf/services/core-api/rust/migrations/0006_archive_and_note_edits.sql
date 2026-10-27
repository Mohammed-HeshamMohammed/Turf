-- Archiving a lead takes it out of everyday lists without removing anything; restoring brings it back as it was.
-- Clients filter archived leads out of their lists; the lead, its history and its links are untouched.
ALTER TABLE leads ADD COLUMN archived_at timestamptz;

-- Notes can be corrected or removed by their author (or anyone who can edit the lead). The audit trail (audit_events) keeps the text
-- as it was before every edit and removal, so the history stays complete even though the row changes.
ALTER TABLE notes ADD COLUMN edited_at timestamptz;
COMMENT ON TABLE notes IS 'Lead notes. Offline duplicates are removed by operation id; edits and removals are kept in audit_events with the previous text.';
