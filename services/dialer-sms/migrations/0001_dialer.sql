-- The dialer's own records (schema dialer_sms). The CRM's call log is in crm-core; these tables hold what the carrier said and
-- what the dialer did, so a webhook can be checked against them, replayed safely and reported to the CRM once.

-- A workspace's phone numbers (rented from the carrier). An inbound call or text finds its workspace here; user_id is the
-- person who takes calls and texts on the number.
CREATE TABLE numbers (
  phone_number text PRIMARY KEY,          -- E.164, like +15125550100
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  calls boolean NOT NULL DEFAULT true,
  texts boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX numbers_org ON numbers(org_id);

-- One row per call (the lead's leg). Facts arrive in any order and more than once; each is kept the first (or best) time it
-- arrives, and the outcome is worked out from all of them together when the call is settled.
CREATE TABLE calls (
  id uuid PRIMARY KEY,                    -- ours; also the CRM operation id, so the call is logged once
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  lead_id uuid,
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  from_number text NOT NULL,
  to_number text NOT NULL,
  route text NOT NULL DEFAULT 'telnyx',   -- the carrier route that carried it (telnyx or telnyx-sim)
  scenario text NOT NULL DEFAULT '',      -- simulator scenario, when simulated
  call_control_id text UNIQUE,
  call_session_id text NOT NULL DEFAULT '',
  amd_mode text NOT NULL DEFAULT '',      -- what machine detection was asked for
  record boolean NOT NULL DEFAULT false,
  voicemail_drop_url text NOT NULL DEFAULT '',
  transfer_to text NOT NULL DEFAULT '',
  -- facts from the carrier
  initiated_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  amd_result text NOT NULL DEFAULT '',    -- human, machine, not_sure, silence, fax
  greeting text NOT NULL DEFAULT '',      -- beep_detected, ended, not_sure
  hangup_cause text NOT NULL DEFAULT '',
  hangup_source text NOT NULL DEFAULT '',
  sip_code text NOT NULL DEFAULT '',
  transfer_answered_at timestamptz,
  playback_ended_at timestamptz,
  voicemail_dropped boolean NOT NULL DEFAULT false,
  recording_url text NOT NULL DEFAULT '',
  recording_started_at timestamptz,
  recording_ended_at timestamptz,
  -- what the person said after the call (wrap-up)
  disposition text NOT NULL DEFAULT '',
  callback_at timestamptz,
  notes text NOT NULL DEFAULT '',
  -- reporting to the CRM
  report_state text NOT NULL DEFAULT 'live' CHECK (report_state IN ('live', 'wrapup', 'due', 'reported', 'failed', 'skipped')),
  settle_after timestamptz,
  attempts int NOT NULL DEFAULT 0,
  outcome text NOT NULL DEFAULT '',
  crm_status text NOT NULL DEFAULT '',
  crm_message text NOT NULL DEFAULT '',
  recording_reported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX calls_due ON calls(settle_after) WHERE report_state IN ('wrapup', 'due');
CREATE INDEX calls_org ON calls(org_id, created_at DESC);
CREATE INDEX calls_lead ON calls(lead_id, created_at DESC);

-- Every webhook, once: the carrier's event id is the key, so a repeat is recognised and ignored.
CREATE TABLE webhook_events (
  id text PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at timestamptz,
  call_id uuid,
  message_id uuid,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_call ON webhook_events(call_id, received_at);

-- Texts, both ways. A text with a lead is a conversation; texting is conversations only (docs/plans/messaging-sms-voice.md).
CREATE TABLE sms_messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid,
  lead_id uuid,
  direction text NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
  from_number text NOT NULL,
  to_number text NOT NULL,
  body text NOT NULL,
  carrier_id text UNIQUE,                 -- the carrier's message id
  route text NOT NULL DEFAULT 'telnyx',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'received', 'refused')),
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sms_thread ON sms_messages(org_id, lead_id, created_at);
CREATE INDEX sms_number ON sms_messages(org_id, from_number, to_number);

-- STOP: a number that asked not to be texted by this workspace. START removes it.
CREATE TABLE sms_opt_outs (
  org_id uuid NOT NULL,
  phone_number text NOT NULL,
  keyword text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, phone_number)
);

-- Consent to be texted that did not come from the person texting first: a form, or agreement on a call.
CREATE TABLE sms_consents (
  org_id uuid NOT NULL,
  phone_number text NOT NULL,
  source text NOT NULL CHECK (source IN ('form', 'call')),
  user_id uuid,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, phone_number)
);

-- Each person's calling login for the browser (the carrier's telephony credential on the SIP connection).
CREATE TABLE agent_credentials (
  user_id uuid PRIMARY KEY,
  credential_id text NOT NULL,
  sip_username text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
