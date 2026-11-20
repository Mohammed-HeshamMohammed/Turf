-- Build step 26, part A: calling scripts, call review, and the switches for the AI's call suggestions.
--   * A calling script belongs to a client (none: the agency's own business), written by the owner, admins or the team leads working
--     for that client; a team can keep its own version, written by its leads. Agents read scripts and never change them (D142).
--   * A team's lead or deputy, an admin or the owner scores a call against the agency's short checklist and comments; the agent sees
--     their own scores, the team's leads its averages (D143).
--   * The owner switches the AI's call suggestions on for the agency and can require captions; a team's leads can switch suggestions
--     off for their team; a person can hide them on their own screen, never captions the agency requires (D148).

CREATE TABLE scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  client_id uuid REFERENCES clients(id),  -- NULL: the agency's own business
  team_id uuid,                           -- NULL: the client's script; set: that team's own version
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX scripts_one_active ON scripts (org_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE archived_at IS NULL;

CREATE TABLE call_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  call_id uuid NOT NULL REFERENCES call_events(id) ON DELETE CASCADE,
  agent_id uuid,
  team_id uuid,
  reviewer_id uuid NOT NULL,
  scores jsonb NOT NULL,                  -- checklist item -> 1 to 5
  score numeric(3,2) NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, reviewer_id)
);
CREATE INDEX call_reviews_agent ON call_reviews (org_id, agent_id, created_at);
CREATE INDEX call_reviews_team ON call_reviews (org_id, team_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['scripts', 'call_reviews'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;

ALTER TABLE orgs ADD COLUMN ai_suggestions boolean NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN captions_required boolean NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN review_checklist jsonb NOT NULL DEFAULT
  '["Said who they are and why they called", "Asked questions and listened", "Followed the script", "Handled objections calmly", "Agreed a clear next step"]';
ALTER TABLE team_settings ADD COLUMN ai_suggestions boolean;  -- NULL: as the agency; false: off for this team
ALTER TABLE people ADD COLUMN hide_suggestions boolean NOT NULL DEFAULT false;
