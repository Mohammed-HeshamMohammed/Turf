-- The currency a person wants amounts shown in (their "main currency"), set in their profile. Empty means automatic: where they are.
ALTER TABLE users ADD COLUMN currency TEXT NOT NULL DEFAULT '';
