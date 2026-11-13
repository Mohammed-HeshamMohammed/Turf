-- The one announcement banner shown across the public site; platform staff edit it from the dashboard.
-- Same portable SQL as 0001: text ids, Unix-second times, 0/1 for yes/no. There is only ever the row with id 'site'.
CREATE TABLE IF NOT EXISTS site_announcement (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  link_label TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT 'info',   -- info, promo or warning
  updated_at BIGINT NOT NULL DEFAULT 0
);
