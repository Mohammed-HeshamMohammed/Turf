-- Build step 10: a lead's texts are one thread with one sender (D16, D17). By default the lead's agent sends; the owner or an admin,
-- a lead of the lead's team and its deputies read, write internal notes and can take over by rank, and hand control back (D18, D76).
-- An incoming text that waits too long tells the team's leads and deputies; a taken-over thread whose holder does not answer in time
-- goes back to the agent, and both are told (D21, D48, D77). The wait is the agency's (15 minutes by default).

CREATE TABLE sms_threads (
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  -- What the CRM said about the lead when last asked: who works it and who leads its team.
  assignee_id uuid,
  team_id uuid,
  team_leads uuid[] NOT NULL DEFAULT '{}',
  team_deputies uuid[] NOT NULL DEFAULT '{}',
  -- Who took the thread over, and as what (owner, lead, deputy); none: the lead's agent sends.
  holder_id uuid,
  holder_rank text NOT NULL DEFAULT '',
  taken_at timestamptz,
  back_asked_at timestamptz,               -- the agent asked for it back (they cannot take it, D18)
  waiting_since timestamptz,               -- the oldest text from the lead not answered yet
  alerted_at timestamptz,                  -- when that wait was told
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, lead_id)
);
CREATE INDEX sms_threads_waiting ON sms_threads (waiting_since) WHERE waiting_since IS NOT NULL AND alerted_at IS NULL;

-- Internal notes in a thread: read and written by everyone who can see it, never sent, and they stay with the lead (D96).
CREATE TABLE sms_notes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  user_id uuid NOT NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_notes_thread ON sms_notes (org_id, lead_id, created_at);

-- Each agency's wait before an unanswered text is told (D21).
CREATE TABLE sms_settings (
  org_id uuid PRIMARY KEY,
  wait_minutes int NOT NULL DEFAULT 15 CHECK (wait_minutes BETWEEN 1 AND 1440)
);

-- What the people concerned are told: a text waiting too long, or control returned to the agent.
CREATE TABLE sms_alerts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unanswered', 'returned')),
  to_users uuid[] NOT NULL,
  seen_by uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_alerts_org ON sms_alerts (org_id, created_at);
