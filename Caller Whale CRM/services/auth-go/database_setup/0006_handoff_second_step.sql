-- A sign-in finished in the person's browser and handed to the desktop app (POST /v1/handoffs) keeps whether the second
-- step was passed there. Provider sign-ins leave it 0, as before.
ALTER TABLE oauth_handoffs ADD COLUMN mfa_passed BIGINT NOT NULL DEFAULT 0;
