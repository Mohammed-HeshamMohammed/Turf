-- Build step 21, part B: joining a live call by rank (D119), recording switched on for the agency or chosen teams with a notice and
-- pauses (D276, D277), recorded voicemail messages per team (D278), and callbacks that come due while their agent is away (D153).

-- Who joined a call, how (listen, whisper, takeover) and when; the agent always sees it.
CREATE TABLE call_joins (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('listen', 'whisper', 'takeover')),
  call_control_id text,
  joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_joins_call ON call_joins (call_id, joined_at);

-- Pauses in a call's recording: where and for how long (captions pause with it).
CREATE TABLE recording_pauses (
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  paused_at timestamptz NOT NULL,
  resumed_at timestamptz,
  PRIMARY KEY (call_id, paused_at)
);

-- Recording switched on by the owner: for the agency (team_id the nil id) or for chosen teams.
CREATE TABLE call_recording (
  org_id uuid NOT NULL,
  team_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  PRIMARY KEY (org_id, team_id)
);

-- Voicemail messages team leads, admins and the owner record, for the agency or a team; an agent picks one when they reach a machine.
CREATE TABLE voicemail_drops (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  team_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  audio_url text NOT NULL CHECK (audio_url LIKE 'https://%'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Callbacks already told about, so they are told once.
CREATE TABLE callback_alerts (
  call_id uuid PRIMARY KEY REFERENCES calls(id) ON DELETE CASCADE,
  told_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE sms_alerts DROP CONSTRAINT sms_alerts_kind_check;
ALTER TABLE sms_alerts ADD CONSTRAINT sms_alerts_kind_check CHECK (kind IN ('unanswered', 'returned', 'callback'));
