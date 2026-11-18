-- Build step 39: carrier registration per agency (US 10DLC) and texting standing (D268, D269, D314).

-- Each agency's own texting brand and campaign with the carriers, submitted through Telnyx. The business details and the
-- campaign's words are what the owner entered; the statuses are Telnyx's.
CREATE TABLE carrier_registrations (
  org_id uuid PRIMARY KEY,
  business jsonb NOT NULL DEFAULT '{}',
  campaign jsonb NOT NULL DEFAULT '{}',
  brand_id text UNIQUE,
  brand_identity text NOT NULL DEFAULT '',     -- VERIFIED, UNVERIFIED, SELF_DECLARED, VETTED_VERIFIED
  brand_status text NOT NULL DEFAULT '',       -- OK, REGISTRATION_PENDING, REGISTRATION_FAILED
  brand_failure text NOT NULL DEFAULT '',
  campaign_id text UNIQUE,
  campaign_status text NOT NULL DEFAULT '',    -- TCR_PENDING ... MNO_PROVISIONED, or a failure
  campaign_failure text NOT NULL DEFAULT '',
  submitted_by uuid,
  submitted_at timestamptz,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Whether each texting number is on the agency's campaign.
ALTER TABLE numbers ADD COLUMN campaign_status text NOT NULL DEFAULT '';

-- A reply that complains (spam, harassment, a lawyer): counted with carriers' spam blocks for the agency's complaint rate.
ALTER TABLE sms_messages ADD COLUMN complaint boolean NOT NULL DEFAULT false;
CREATE INDEX sms_recent ON sms_messages (org_id, created_at);

-- Each agency's texting standing from its opt-out and complaint rates: warned, then limited, then suspended until staff review.
CREATE TABLE texting_standing (
  org_id uuid PRIMARY KEY,
  step text NOT NULL DEFAULT 'ok' CHECK (step IN ('ok', 'warned', 'limited', 'suspended')),
  since timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL DEFAULT '',
  texts int NOT NULL DEFAULT 0,                -- over the last 30 days
  opt_outs int NOT NULL DEFAULT 0,
  complaints int NOT NULL DEFAULT 0,
  calm_since timestamptz,                      -- rates under the warning line since then
  appeal text NOT NULL DEFAULT '' CHECK (length(appeal) <= 2000),
  appeal_at timestamptz,
  checked_at timestamptz
);

-- Every change of step, kept.
CREATE TABLE texting_steps (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  step text NOT NULL,
  reason text NOT NULL DEFAULT '',
  by_whom text NOT NULL DEFAULT 'rates',       -- rates, staff, or appeal
  note text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX texting_steps_org ON texting_steps (org_id, at DESC);
