-- How each session began: "password", "google" or "apple". Every access token says so, so the apps can show how a
-- person signs in. Sessions from before this say "password".
ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'password';
ALTER TABLE oauth_handoffs ADD COLUMN provider TEXT NOT NULL DEFAULT 'password';
