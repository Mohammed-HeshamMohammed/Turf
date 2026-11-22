-- Build step 10, part B: working hours (the unanswered-text wait counts only while the agency, or the lead's team, is working, D79),
-- text templates (D210), texts scheduled for later (D211), and one message to many leads (D212).

-- Working hours: the agency's (team_id is the nil id) and any team's own. days: {"mon": ["09:00", "17:00"], ...}; a day left out is
-- closed. No row: always working.
CREATE TABLE sms_hours (
  org_id uuid NOT NULL,
  team_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  time_zone text NOT NULL,
  days jsonb NOT NULL,
  PRIMARY KEY (org_id, team_id)
);

-- Templates the owner, admins and team leads write, for the whole agency or one team, with fields like {first_name}.
CREATE TABLE sms_templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  team_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 1600),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_templates_org ON sms_templates (org_id, name);

-- A text waiting for its time. Sent by the person who scheduled it, as their rights are then; cancelled when the number is blocked.
ALTER TABLE sms_messages DROP CONSTRAINT sms_messages_status_check;
ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check CHECK (status IN ('scheduled', 'queued', 'sent', 'delivered', 'failed', 'received', 'refused', 'cancelled'));
ALTER TABLE sms_messages ADD COLUMN send_at timestamptz;
ALTER TABLE sms_messages ADD COLUMN batch_id uuid;            -- one message to many leads: the texts sent together
CREATE INDEX sms_scheduled ON sms_messages (send_at) WHERE status = 'scheduled';
