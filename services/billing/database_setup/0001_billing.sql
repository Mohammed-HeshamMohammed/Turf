-- Billing's own tables (docs/plans/billing-service.md). Only the billing service applies this file, with its own login.
-- Money is stored as whole minor units (cents) with an ISO 4217 currency code; never as floating point.

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE billing.plans (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  seats integer NOT NULL CHECK (seats >= 0),
  monthly_minutes bigint NOT NULL CHECK (monthly_minutes >= 0),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- The payment provider's price this plan is sold as (Paddle's pri_...), so a webhook can name the plan.
  provider_price_id text UNIQUE,
  active boolean NOT NULL DEFAULT true
);

-- One subscription per workspace. Written only from the payment provider's signed webhooks (or a trial when a workspace opens).
CREATE TABLE billing.subscriptions (
  org_id uuid PRIMARY KEY,
  plan_key text NOT NULL REFERENCES billing.plans (key),
  status text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'canceled')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  provider text,
  provider_subscription_id text UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- What was used, append-only. account_id is the workspace for call minutes and the person for desktop credits. A retry with
-- the same request id is the same row, so nothing is ever counted twice.
CREATE TABLE billing.ledger (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('minutes', 'credits')),
  amount bigint NOT NULL CHECK (amount <> 0),
  request_id uuid NOT NULL,
  detail text NOT NULL DEFAULT '' CHECK (length(detail) <= 200),
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, request_id)
);
CREATE INDEX ledger_by_period ON billing.ledger (account_id, kind, at);

CREATE FUNCTION billing.refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'billing.ledger is append-only: add a correcting row instead';
END
$$;
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON billing.ledger FOR EACH ROW EXECUTE FUNCTION billing.refuse_change();

-- Monthly desktop credits per person, set by Caller Whale's staff. A person without a row has no credit limit.
CREATE TABLE billing.credit_limits (
  user_id uuid PRIMARY KEY,
  monthly_credits bigint NOT NULL CHECK (monthly_credits BETWEEN 0 AND 1000000000),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every webhook as it arrived, once per provider event id: a redelivery changes nothing.
CREATE TABLE billing.webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (provider, event_id)
);

-- Payments the provider reported. Money never moves through Caller Whale's servers: these are records of what it took.
CREATE TABLE billing.payments (
  id bigserial PRIMARY KEY,
  org_id uuid,
  provider text NOT NULL,
  provider_payment_id text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL,
  at timestamptz NOT NULL,
  UNIQUE (provider, provider_payment_id)
);
