-- Build step 37: sending a lead to another agency (D248-D254, D373). A referral is between two agencies, so it is kept outside either
-- agency's rows; the service only ever reads one by an id together with the asking agency's own id.
CREATE TABLE lead_referrals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_org uuid NOT NULL,
  to_org uuid NOT NULL,
  from_lead_id uuid NOT NULL,
  to_lead_id uuid,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'declined', 'cancelled')),
  -- What travels: the contact details and the sender's note (D249). Never calls, texts, internal notes, consent or client data.
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  blocks jsonb NOT NULL DEFAULT '[]',          -- the sender's blocks on the number, which go with it (D251)
  prev_stage text NOT NULL DEFAULT '',          -- the sender's copy reopens to it when declined (D252)
  prev_verdict text NOT NULL DEFAULT '',
  consent_confirmed_at timestamptz NOT NULL,    -- the sender confirmed the person agreed to be passed on (D254)
  consent_confirmed_by uuid NOT NULL,
  sent_by uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decline_reason text NOT NULL DEFAULT '' CHECK (length(decline_reason) <= 500),
  -- An agreed referral fee (D253): one side notes it, the other agrees; the money changes hands outside Caller Whale.
  fee_note text NOT NULL DEFAULT '' CHECK (length(fee_note) <= 300),
  fee_noted_by_org uuid,
  fee_agreed_at timestamptz,
  -- Whether the sender is told when the deal closes: both must agree (D250).
  share_close_from boolean NOT NULL DEFAULT false,
  share_close_to boolean NOT NULL DEFAULT false,
  deal_closed_at timestamptz,
  fee_reminded_at timestamptz                  -- the reminder at close went out once
);
CREATE INDEX lead_referrals_from ON lead_referrals (from_org, sent_at);
CREATE INDEX lead_referrals_to ON lead_referrals (to_org, sent_at);
CREATE INDEX lead_referrals_to_lead ON lead_referrals (to_lead_id);

-- A block that came with a sent lead cannot be lifted by the agency that received it (D251).
ALTER TABLE number_blocks ADD COLUMN locked boolean NOT NULL DEFAULT false;
ALTER TABLE number_blocks DROP CONSTRAINT number_blocks_source_check;
ALTER TABLE number_blocks ADD CONSTRAINT number_blocks_source_check CHECK (source IN ('', 'lead', 'call', 'text', 'import', 'list', 'referral'));
