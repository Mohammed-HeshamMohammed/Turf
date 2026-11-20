-- Ready-made plans and what each allows, plus the limits staff give one workspace when they give a membership
-- (docs/plans/README.md tier table; prices are the all-in prices in docs/plans/custom-plans.md, in cents).
-- A limit with value NULL is unlimited. A workspace's limit is its override when it has one, otherwise its plan's.

INSERT INTO billing.plans (key, name, seats, monthly_minutes, price_minor, currency) VALUES
  ('trial',  'Free trial', 1,    30,     0, 'USD'),
  ('solo',   'Solo',       1,  3000, 17900, 'USD'),
  ('duo',    'Duo',        2,  6000, 28800, 'USD'),
  ('team',   'Team',       3,  9000, 43800, 'USD'),  -- $146 per seat, 3 seats included
  ('pro',    'Pro',        3, 24000, 90000, 'USD'),  -- $300 per seat, 3 seats included
  ('custom', 'Custom',     1,     0,     0, 'USD')   -- every limit is typed in by staff
ON CONFLICT (key) DO NOTHING;

CREATE TABLE billing.plan_limits (
  plan_key text NOT NULL REFERENCES billing.plans (key) ON DELETE CASCADE,
  key text NOT NULL CHECK (key IN ('clients', 'active_leads', 'imports_monthly', 'skiptrace_credits')),
  value bigint CHECK (value IS NULL OR value >= 0),
  PRIMARY KEY (plan_key, key)
);

-- seats and monthly_minutes stay on billing.plans; these are the other limits. Clients are free and unlimited on every plan.
INSERT INTO billing.plan_limits (plan_key, key, value) VALUES
  ('trial', 'clients', NULL), ('trial', 'active_leads',    25000), ('trial', 'imports_monthly', 5),    ('trial', 'skiptrace_credits',    25000),
  ('solo',  'clients', NULL), ('solo',  'active_leads',  1000000), ('solo',  'imports_monthly', NULL), ('solo',  'skiptrace_credits',  1000000),
  ('duo',   'clients', NULL), ('duo',   'active_leads',  2000000), ('duo',   'imports_monthly', NULL), ('duo',   'skiptrace_credits',  2000000),
  ('team',  'clients', NULL), ('team',  'active_leads',  3000000), ('team',  'imports_monthly', NULL), ('team',  'skiptrace_credits',  3000000),
  ('pro',   'clients', NULL), ('pro',   'active_leads',  7500000), ('pro',   'imports_monthly', NULL), ('pro',   'skiptrace_credits',  9000000),
  ('custom','clients', NULL), ('custom','active_leads',        0), ('custom','imports_monthly', 0),    ('custom','skiptrace_credits',        0)
ON CONFLICT DO NOTHING;

CREATE TABLE billing.org_limit_overrides (
  org_id uuid NOT NULL,
  key text NOT NULL CHECK (key IN ('seats', 'clients', 'active_leads', 'imports_monthly', 'monthly_minutes', 'skiptrace_credits')),
  value bigint CHECK (value IS NULL OR value >= 0),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  set_by text NOT NULL DEFAULT '',
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);
