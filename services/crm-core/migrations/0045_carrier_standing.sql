-- Build step 39: each agency's carrier registration and texting standing as the dialer reports it (D268, D269, D271, D314). Kept
-- outside the agencies' rows: staff read it across agencies (agency-level numbers only, never leads), and the import check reads it.
CREATE TABLE carrier_standing (
  org_id uuid PRIMARY KEY,
  state text NOT NULL DEFAULT 'not_submitted',
  check_required boolean NOT NULL DEFAULT true,
  may_call boolean NOT NULL DEFAULT false,
  may_text boolean NOT NULL DEFAULT false,
  brand_identity text NOT NULL DEFAULT '',
  campaign_status text NOT NULL DEFAULT '',
  step text NOT NULL DEFAULT 'ok',
  step_since timestamptz,
  reason text NOT NULL DEFAULT '',
  texts int NOT NULL DEFAULT 0,
  opt_outs int NOT NULL DEFAULT 0,
  complaints int NOT NULL DEFAULT 0,
  appeal text NOT NULL DEFAULT '',
  appeal_at timestamptz,
  cleared_at timestamptz,                     -- staff reviewed the agency's texting and ended a step
  cleared_by uuid,
  clear_note text NOT NULL DEFAULT '' CHECK (length(clear_note) <= 1000),
  updated_at timestamptz NOT NULL DEFAULT now()
);
