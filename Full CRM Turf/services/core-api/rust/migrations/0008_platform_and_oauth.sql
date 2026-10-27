-- The people who run Turf the service, and sign-in with Google or Apple.

-- A platform administrator sees every customer organization's plan, usage and payments (never their CRM records).
ALTER TABLE users ADD COLUMN platform_admin boolean NOT NULL DEFAULT false;

-- Accounts linked to an outside sign-in. The provider's subject is the stable key; the email is only what it said then.
CREATE TABLE user_identities (
  provider text NOT NULL CHECK (provider IN ('google', 'apple')),
  subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject)
);
CREATE INDEX user_identities_user ON user_identities (user_id);

-- One row per sign-in started with a provider, used once and only for ten minutes. Only the state's hash is kept.
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('google', 'apple')),
  nonce text NOT NULL,
  code_verifier text,
  target text NOT NULL CHECK (target IN ('website', 'app')),
  expires_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_identities, oauth_states TO turf_app;

-- Every organization at a glance, for platform administrators only. It reads across organizations, so it runs as the
-- owner and checks the caller itself: anyone else gets an error, not an empty list.
CREATE OR REPLACE FUNCTION turf_platform_overview(p_user uuid)
RETURNS TABLE (
  id uuid, name text, account_kind text, created_at timestamptz, plan_key text, status text, seats int,
  minutes_included int, minutes_used bigint, period_end timestamptz, members bigint, owner_email text, paid_cents bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user AND u.platform_admin AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'not a platform administrator' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT o.id, o.name, o.account_kind, o.created_at, s.plan_key, s.status, s.seats, s.minutes_included,
         coalesce((SELECT sum(e.billed_minutes) FROM usage_events e WHERE e.org_id = o.id AND e.period_start = s.period_start), 0)::bigint,
         s.period_end,
         (SELECT count(*) FROM memberships m WHERE m.org_id = o.id),
         (SELECT u.email::text FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = o.id AND 'owner' = ANY(m.roles) ORDER BY m.created_at LIMIT 1),
         coalesce((SELECT sum(p.amount_cents) FROM payments p WHERE p.org_id = o.id AND p.status = 'paid'), 0)::bigint
  FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id
  ORDER BY o.created_at DESC;
END $$;
REVOKE ALL ON FUNCTION turf_platform_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION turf_platform_overview(uuid) TO turf_app;
