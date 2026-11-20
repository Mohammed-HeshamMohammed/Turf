-- The "Start for free" tab on the right edge of the home page hero, edited together with the announcement banner.
ALTER TABLE site_announcement ADD COLUMN IF NOT EXISTS tab_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE site_announcement ADD COLUMN IF NOT EXISTS tab_text TEXT NOT NULL DEFAULT 'Start for free';
ALTER TABLE site_announcement ADD COLUMN IF NOT EXISTS tab_url TEXT NOT NULL DEFAULT '/signup';
