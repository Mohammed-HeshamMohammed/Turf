-- What a person agreed to and told us at sign-up. terms_version is the version of the terms and privacy notice they accepted (a new
-- version asks again). work_profile is their answers about their work, as JSON; empty until given.
ALTER TABLE users ADD COLUMN terms_version TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN terms_accepted_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN work_profile TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN work_profile_at BIGINT NOT NULL DEFAULT 0;
