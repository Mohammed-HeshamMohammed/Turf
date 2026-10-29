-- Desktop access by invitation from Turf's staff, with a monthly credit limit per person.
--
-- Staff invite a person by email from the admin dashboard and set how many credits they may use each month. The
-- person signs in on the website with that email (password or Google; the email must be confirmed), which activates
-- the invitation: they get a workspace of their own and may download and use the desktop app. Usage is a ledger, one
-- row per metered action, never updated; a month's usage is the sum of its rows. Staff can change the limit, suspend
-- and reactivate a person, and see what they used. Not tied to one organization, so outside row security, like
-- platform_events.

CREATE TABLE access_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  -- Credits the person may use per calendar month (UTC).
  monthly_credits bigint NOT NULL CHECK (monthly_credits BETWEEN 0 AND 1000000000),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  -- Set when the person first signs in with the invited email: their account and the workspace opened for them.
  user_id uuid UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  invited_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  emailed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX access_invitations_created ON access_invitations (created_at DESC);

CREATE TABLE credit_usage (
  id bigserial PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES access_invitations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('skip_trace')),
  credits bigint NOT NULL CHECK (credits > 0),
  -- The client's id for the action, so a retry is counted once.
  request_id uuid NOT NULL UNIQUE,
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 200),
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_usage_month ON credit_usage (invitation_id, at);

GRANT SELECT, INSERT, UPDATE, DELETE ON access_invitations TO turf_app;
GRANT SELECT, INSERT ON credit_usage TO turf_app;
GRANT USAGE ON SEQUENCE credit_usage_id_seq TO turf_app;
