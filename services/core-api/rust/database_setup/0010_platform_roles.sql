-- Who runs Caller Whale the service, and the highest anyone else can be.
--
-- Caller Whale's own people have a platform role: one platform owner (the owner of the app) and the system administrators the
-- owner appoints. Nobody gets either by signing up, by an invitation or through any customer page. The owner is set
-- once, on the server, with the owning role (scripts/create_platform_owner.py); system administrators are named and
-- removed only by the owner, through callerwhale_platform_set_role. The API's own login can never change a platform role.
--
-- Inside a customer's workspace the highest role is the business owner: the person who opened it. There is no
-- "System administrator" role in customers' workspaces any more, and the owner role cannot be handed to anyone.

ALTER TABLE users ADD COLUMN platform_role text CHECK (platform_role IN ('owner', 'admin'));
UPDATE users SET platform_role = 'admin' WHERE platform_admin;
CREATE UNIQUE INDEX users_one_platform_owner ON users ((true)) WHERE platform_role = 'owner';

-- Whoever is not the owner of the users table (the API's login) cannot give or change a platform role, and cannot
-- disable the platform owner. The owning role and its SECURITY DEFINER functions can.
CREATE OR REPLACE FUNCTION callerwhale_guard_platform_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = 'users'::regclass), 'USAGE') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.platform_role IS NOT NULL
     OR TG_OP = 'UPDATE' AND NEW.platform_role IS DISTINCT FROM OLD.platform_role
     OR TG_OP = 'UPDATE' AND OLD.platform_role = 'owner' AND NEW.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'platform roles are given only by the platform owner' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER users_platform_role BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION callerwhale_guard_platform_role();

-- The only way the API can name or remove a system administrator: the actor must be the platform owner, and the
-- owner role itself can never be given this way.
CREATE OR REPLACE FUNCTION callerwhale_platform_set_role(p_actor uuid, p_target uuid, p_role text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_actor AND u.platform_role = 'owner' AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'only the platform owner can change system administrators' USING ERRCODE = '42501';
  END IF;
  IF p_role IS NOT NULL AND p_role <> 'admin' THEN
    RAISE EXCEPTION 'only the system administrator role can be given' USING ERRCODE = '22023';
  END IF;
  UPDATE users SET platform_role = p_role WHERE id = p_target AND platform_role IS DISTINCT FROM 'owner';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such person, or the platform owner' USING ERRCODE = 'P0002';
  END IF;
END $$;
REVOKE ALL ON FUNCTION callerwhale_platform_set_role(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION callerwhale_platform_set_role(uuid, uuid, text) TO callerwhale_app;

-- The owner can take a workspace off its plan entirely (no limits) from the dashboard.
GRANT DELETE ON subscriptions TO callerwhale_app;

-- A workspace Caller Whale has suspended opens nothing until it is reactivated.
ALTER TABLE organizations ADD COLUMN suspended_at timestamptz;

-- What Caller Whale's people did from the admin dashboard. Not tied to one organization, so outside row security.
CREATE TABLE platform_events (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  target_kind text NOT NULL,
  target_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_events_at ON platform_events (at DESC);
GRANT SELECT, INSERT ON platform_events TO callerwhale_app;
GRANT USAGE ON SEQUENCE platform_events_id_seq TO callerwhale_app;

-- The overview now reads the platform role and shows suspension.
DROP FUNCTION callerwhale_platform_overview(uuid);
CREATE FUNCTION callerwhale_platform_overview(p_user uuid)
RETURNS TABLE (
  id uuid, name text, account_kind text, created_at timestamptz, plan_key text, status text, seats int,
  minutes_included int, minutes_used bigint, period_end timestamptz, members bigint, owner_email text, paid_cents bigint,
  suspended_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user AND u.platform_role IS NOT NULL AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'not a platform administrator' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT o.id, o.name, o.account_kind, o.created_at, s.plan_key, s.status, s.seats, s.minutes_included,
         coalesce((SELECT sum(e.billed_minutes) FROM usage_events e WHERE e.org_id = o.id AND e.period_start = s.period_start), 0)::bigint,
         s.period_end,
         (SELECT count(*) FROM memberships m WHERE m.org_id = o.id),
         (SELECT u.email::text FROM memberships m JOIN users u ON u.id = m.user_id
           WHERE m.org_id = o.id AND 'owner' = ANY(m.roles) ORDER BY m.created_at LIMIT 1),
         coalesce((SELECT sum(p.amount_cents) FROM payments p WHERE p.org_id = o.id AND p.status = 'paid'), 0)::bigint,
         o.suspended_at
  FROM organizations o LEFT JOIN subscriptions s ON s.org_id = o.id
  ORDER BY o.created_at DESC;
END $$;
REVOKE ALL ON FUNCTION callerwhale_platform_overview(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION callerwhale_platform_overview(uuid) TO callerwhale_app;

ALTER TABLE users DROP COLUMN platform_admin;

-- Customers' workspaces: the business owner manages access, and nobody else can be given that.
UPDATE roles SET capabilities = ARRAY(SELECT DISTINCT unnest(capabilities || ARRAY['admin']) ORDER BY 1) WHERE key = 'owner';
UPDATE roles SET capabilities = array_remove(capabilities, 'admin') WHERE key NOT IN ('owner', 'solo');
UPDATE memberships SET roles = array_remove(roles, 'admin') WHERE 'admin' = ANY(roles) AND 'owner' = ANY(roles);
UPDATE memberships SET roles = ARRAY(SELECT DISTINCT unnest(array_replace(roles, 'admin', 'manager')) ORDER BY 1) WHERE 'admin' = ANY(roles);
UPDATE invitations SET roles = ARRAY(SELECT DISTINCT unnest(array_replace(array_replace(roles, 'admin', 'manager'), 'owner', 'manager')) ORDER BY 1)
  WHERE roles && ARRAY['admin', 'owner'];
DELETE FROM roles WHERE key = 'admin';
