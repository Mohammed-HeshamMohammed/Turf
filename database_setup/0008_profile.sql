-- Optional public profile details, stored by auth and returned only to the owner.
ALTER TABLE users ADD COLUMN phone TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT '';
-- Link requests are tied to the existing signed-in session. The OAuth state remains single-use.
ALTER TABLE oauth_states ADD COLUMN link_user_id TEXT;
ALTER TABLE oauth_states ADD COLUMN link_session_id TEXT;
