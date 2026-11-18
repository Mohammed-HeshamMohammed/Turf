-- Build step 15. The emailed invitation link carries a one-time key: holding it proves the address, so a new person signs up inside the
-- invitation with that address already confirmed (D47, D368). Sessions remember when the second step was last passed, so owners,
-- admins and team leads are asked for their code again after 7 days (D188). A "shared" session is a browser on a shared device:
-- it lasts 12 hours at most and the website keeps it only while the tab is open (D38).
ALTER TABLE access_invitations ADD COLUMN link_key_hash TEXT;
ALTER TABLE sessions ADD COLUMN mfa_at BIGINT;
UPDATE sessions SET mfa_at = created_at WHERE mfa_passed = 1;
