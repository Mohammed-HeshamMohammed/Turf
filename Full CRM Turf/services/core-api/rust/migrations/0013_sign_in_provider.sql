-- How each person last signed in ("password", "google", "apple"), from their token, so the people lists can show it.
-- Empty until their next request.
ALTER TABLE users ADD COLUMN sign_in_provider text CHECK (length(sign_in_provider) <= 40);
