-- A row of an import into one team that matches a lead another team holds (D112) is held as 'other_team' instead of being merged into
-- that lead: the importing team sees only how many, and the owner or an admin decides (keep theirs, both keep a copy, or move it here).
ALTER TABLE importing.rows DROP CONSTRAINT IF EXISTS rows_state_check;
ALTER TABLE importing.rows ADD CONSTRAINT rows_state_check CHECK (state IN ('loaded', 'clean', 'near_duplicate', 'skip', 'merge', 'import', 'merged', 'other_team'));
