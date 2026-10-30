-- Caller Whale as a paid service: plans, one subscription per organization, a minute ledger, payments and email verification.
-- An organization made by /auth/bootstrap (a self-hosted server) has no subscription row and is not limited; every
-- organization made by public sign-up starts on the trial.

-- The catalogue. Reference data shared by every organization, so no org_id and no row security; the API only reads it.
-- Prices are in cents. For a per-seat plan the price and the minutes are per seat.
CREATE TABLE plans (
  key text PRIMARY KEY CHECK (key IN ('trial', 'solo', 'business')),
  name text NOT NULL,
  price_cents int NOT NULL CHECK (price_cents >= 0),
  per_seat boolean NOT NULL,
  included_minutes int NOT NULL CHECK (included_minutes >= 0),
  min_seats int NOT NULL CHECK (min_seats >= 1),
  max_seats int NOT NULL CHECK (max_seats >= min_seats),
  can_invite boolean NOT NULL,
  period_days int NOT NULL CHECK (period_days > 0),
  available boolean NOT NULL DEFAULT true
);

INSERT INTO plans (key, name, price_cents, per_seat, included_minutes, min_seats, max_seats, can_invite, period_days) VALUES
  ('trial', 'Free trial', 0, false, 10, 1, 1, false, 7),
  ('solo', 'Solo operator', 14900, false, 5000, 1, 1, false, 30),
  ('business', 'Business', 12900, true, 4000, 2, 500, true, 30);

ALTER TABLE organizations ADD COLUMN account_kind text NOT NULL DEFAULT 'business' CHECK (account_kind IN ('trial', 'solo', 'business'));

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

CREATE TABLE subscriptions (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key text NOT NULL REFERENCES plans(key),
  status text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  seats int NOT NULL CHECK (seats >= 1),
  -- Minutes for the current period: the plan's minutes, times the seats on a per-seat plan.
  minutes_included int NOT NULL CHECK (minutes_included >= 0),
  period_start timestamptz NOT NULL DEFAULT now(),
  period_end timestamptz NOT NULL,
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
);

-- The minute ledger: one row per finished call, never updated. Usage for a period is the sum of its rows.
CREATE TABLE usage_events (
  id bigserial PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  call_session_id uuid UNIQUE REFERENCES call_sessions(id) ON DELETE SET NULL,
  seconds int NOT NULL CHECK (seconds >= 0),
  billed_minutes int NOT NULL CHECK (billed_minutes >= 0),
  period_start timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_period ON usage_events (org_id, period_start);

-- A checkout and its result. The provider confirms payment by webhook; nothing is activated from the browser.
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_key text NOT NULL REFERENCES plans(key),
  seats int NOT NULL CHECK (seats >= 1),
  amount_cents int NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  provider text NOT NULL,
  provider_ref text UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX payments_org ON payments (org_id, created_at DESC);

-- One-time email verification links; only the hash is kept, like sessions and invitations.
CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- Calls carry their own length once ended, so a minute is counted from the server's clock, never the client's.
ALTER TABLE call_sessions ADD COLUMN seconds int CHECK (seconds >= 0);
-- The most a call may last, fixed when it starts from the minutes then left.
ALTER TABLE call_sessions ADD COLUMN max_seconds int CHECK (max_seconds >= 0);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscriptions', 'usage_events', 'payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = callerwhale_org()) WITH CHECK (org_id = callerwhale_org())', t);
  END LOOP;
END $$;
GRANT SELECT ON plans TO callerwhale_app;
GRANT SELECT, INSERT, UPDATE ON subscriptions, payments TO callerwhale_app;
-- The ledger is append-only for the API.
GRANT SELECT, INSERT ON usage_events TO callerwhale_app;
GRANT SELECT, INSERT, UPDATE ON email_verifications TO callerwhale_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO callerwhale_app;

-- Payment webhooks arrive before any organization is known; this finds the payment's organization and nothing else.
CREATE OR REPLACE FUNCTION callerwhale_payment_org(p_payment uuid) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT org_id FROM payments WHERE id = p_payment $$;
REVOKE ALL ON FUNCTION callerwhale_payment_org(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION callerwhale_payment_org(uuid) TO callerwhale_app;
