-- Build step 22: budgets. Paid usage (call minutes, texts) comes from the agency's allowance; the owner or an admin can give a team
-- or a client a monthly budget, a team's lead sets limits for its people within it (D120, D121, D135). Each use is charged to the
-- lead's team and client, whoever made it (D122). When a budget runs out, those paid actions stop and the person can ask for more
-- (D123). Replies from leads are never charged.

CREATE TABLE billing.usage (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('minutes', 'texts')),
  amount bigint NOT NULL CHECK (amount > 0),
  team_id uuid,
  user_id uuid,
  client_id uuid,
  request_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, request_id)
);
CREATE INDEX usage_month ON billing.usage (org_id, kind, at);

CREATE TABLE billing.budgets (
  org_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('team', 'person', 'client')),
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('minutes', 'texts')),
  monthly bigint NOT NULL CHECK (monthly >= 0),
  set_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, scope, subject_id, kind)
);

CREATE TABLE billing.raise_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('team', 'person', 'client')),
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('minutes', 'texts')),
  asked_by uuid NOT NULL,
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);
CREATE INDEX raise_requests_open ON billing.raise_requests (org_id, at) WHERE closed_at IS NULL;
