-- Build step 21, part A: each team has its own numbers, given by the owner or an admin, and the agency a default one (D116); agents
-- have a status (D152); the agency may shorten the hours leads are called and texted (D151).
ALTER TABLE numbers ADD COLUMN team_id uuid;                          -- a team's number; none: the agency's
ALTER TABLE numbers ADD COLUMN is_default boolean NOT NULL DEFAULT false; -- the agency's default, for teams without one
CREATE UNIQUE INDEX numbers_one_default ON numbers (org_id) WHERE is_default;

-- available, break or off (set by the agent); "on a call" is worked out from the calls.
CREATE TABLE agent_status (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('available', 'break', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- The agency's own window for calling and texting leads, inside the legal one (8:00 to 21:00); never longer (D151).
ALTER TABLE sms_settings ADD COLUMN contact_from int NOT NULL DEFAULT 8 CHECK (contact_from BETWEEN 8 AND 20);
ALTER TABLE sms_settings ADD COLUMN contact_until int NOT NULL DEFAULT 21 CHECK (contact_until BETWEEN 9 AND 21);
