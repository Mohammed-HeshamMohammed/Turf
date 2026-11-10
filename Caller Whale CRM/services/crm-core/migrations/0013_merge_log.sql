-- Which of a lead's fields a merged row filled in (an import folds a row into a lead it matched and only fills what the lead is missing).
-- Kept so the person can see what a merge did and undo it. NULL for rows that became new leads.
ALTER TABLE importing.rows ADD COLUMN IF NOT EXISTS filled text[];
