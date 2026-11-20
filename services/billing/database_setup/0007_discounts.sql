-- Build step 45: discounts a workspace earns (D325): an agency that agrees to shared learning pays less for AI features while it
-- keeps agreeing. One row per reason and kind; a percent of 0 removes it. Prices read the largest discount for their kind.
CREATE TABLE billing.discounts (
  org_id uuid NOT NULL,
  reason text NOT NULL CHECK (reason IN ('shared_learning')),
  kind text NOT NULL CHECK (kind IN ('ai', 'minutes', 'texts')),
  percent int NOT NULL CHECK (percent > 0 AND percent <= 100),
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, reason, kind)
);
