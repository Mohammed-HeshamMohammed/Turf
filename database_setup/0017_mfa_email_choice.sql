-- A person can turn off the codes sent to their email as a way to answer the second step (1 = off). Their authenticator, Telegram and
-- approvals on a signed-in device are unaffected.
ALTER TABLE users ADD COLUMN mfa_email_off BIGINT NOT NULL DEFAULT 0;
