-- Each person's profile picture as their account has it (a small image or an address), sent by their CRM when they open it, so the
-- rest of the team sees the same face on the Team page, on leads and on tasks.
ALTER TABLE people ADD COLUMN IF NOT EXISTS avatar text NOT NULL DEFAULT '';
