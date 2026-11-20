-- Age check: the date of birth a person gave (YYYY-MM-DD) and when they gave it. Empty means not given yet: the website and the CRM
-- ask before anything else. It is set once and not changed afterwards, so a refused date cannot be retried with a better one.
ALTER TABLE users ADD COLUMN birth_date TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN age_confirmed_at BIGINT NOT NULL DEFAULT 0;
