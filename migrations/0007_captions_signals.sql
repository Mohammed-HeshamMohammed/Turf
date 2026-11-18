-- Build step 26, part B: captions during a call and the practical signals read from them.
--   * Captions run on an answered call when the agency requires them or the AI's suggestions are on for the caller (D148); they pause
--     with the recording (D277). Only finished lines are kept. English at opening (D285).
--   * Signals: a callback asked for, with its time (D359); agreeing to meet (D360); an opt-out, for this agency or for anyone, as advice
--     the agent confirms (D352, D351); and practical signs with a clear action: asked about price, wants to sell soon, mentioned another
--     buyer (D362). Nobody is scored on mood. The call's outcome is pre-selected from them (D361).
--   * Each agency keeps captions and recordings as long as it chose (D147); what is past that is removed.
ALTER TABLE calls ADD COLUMN captions boolean NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN suggestions boolean NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN captions_paused boolean NOT NULL DEFAULT false;
ALTER TABLE calls ADD COLUMN suggested_outcome text NOT NULL DEFAULT '';
ALTER TABLE calls ADD COLUMN dnc_kind text NOT NULL DEFAULT '' CHECK (dnc_kind IN ('', 'agency', 'anyone', 'complainer'));

CREATE TABLE call_captions (
  id bigserial PRIMARY KEY,
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  at timestamptz NOT NULL,
  speaker text NOT NULL DEFAULT 'lead',
  text text NOT NULL
);
CREATE INDEX call_captions_call ON call_captions (call_id, id);
CREATE INDEX call_captions_age ON call_captions (org_id, at);

CREATE TABLE call_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  lead_id uuid,
  kind text NOT NULL CHECK (kind IN ('callback', 'meeting', 'opt_out', 'opt_out_anyone', 'asked_price', 'sell_soon', 'other_buyer')),
  said text NOT NULL DEFAULT '',
  suggested_at timestamptz,             -- a callback's time, inside calling hours
  created_at timestamptz NOT NULL DEFAULT now(),
  decision text NOT NULL DEFAULT '' CHECK (decision IN ('', 'confirmed', 'dismissed')),
  decided_by uuid,
  decided_at timestamptz,
  UNIQUE (call_id, kind)
);
CREATE INDEX call_signals_lead ON call_signals (org_id, lead_id, created_at);

-- How long the agency keeps recordings and captions (NULL: until Caller Whale's limit, set after the lawyer's review).
ALTER TABLE sms_settings ADD COLUMN call_keep_days int CHECK (call_keep_days IS NULL OR call_keep_days BETWEEN 7 AND 3650);
