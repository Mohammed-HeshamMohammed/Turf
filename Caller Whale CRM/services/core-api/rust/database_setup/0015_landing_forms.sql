-- The website's waitlist. Anyone may join from the landing page, so a row belongs to no workspace and no person: it sits outside
-- row security, like platform_events. The server only adds to it and reads it; staff read it in the admin dashboard.
-- (Contact-form messages are not stored: the server emails them on through the notification service.)

CREATE TABLE landing_waitlist (
  email citext PRIMARY KEY CHECK (length(email) BETWEEN 3 AND 254),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 120),
  company text NOT NULL DEFAULT '' CHECK (length(company) <= 120),
  tier text NOT NULL DEFAULT '' CHECK (tier IN ('', 'solo', 'duo', 'team', 'pro')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX landing_waitlist_created ON landing_waitlist (created_at DESC);

GRANT SELECT, INSERT ON landing_waitlist TO callerwhale_app;
