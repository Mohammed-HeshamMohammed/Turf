-- When a finished import's rows were copied (as hashes and shapes only) to the separate learning store. After a week the personal
-- details in the holding rows are blanked; the fingerprint and the link to the lead stay.
ALTER TABLE importing.jobs ADD COLUMN learned_at timestamptz;
