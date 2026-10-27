-- Time-limited access, and the platform's view of payments.

-- A member's access to a workspace can end on a date: a temporary caller, a contractor, a trial of a role. After that
-- moment the membership opens nothing (every request reads it), until the owner extends it or removes it. The
-- workspace owner has no end date. An invitation can carry a period that starts when it is accepted.
ALTER TABLE memberships ADD COLUMN expires_at timestamptz;
ALTER TABLE invitations ADD COLUMN access_days int CHECK (access_days BETWEEN 1 AND 3650);

-- Every payment across workspaces, for Turf's staff only. It reads across organizations, so it runs as the owner and
-- checks the caller itself (an error, not an empty list, for anyone else).
CREATE FUNCTION turf_platform_payments(p_user uuid)
RETURNS TABLE (
  id uuid, org_id uuid, org_name text, plan_key text, seats int, amount_cents int, currency text, status text,
  provider text, created_at timestamptz, paid_at timestamptz, payer_email text
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p_user AND u.platform_role IS NOT NULL AND u.disabled_at IS NULL) THEN
    RAISE EXCEPTION 'not a platform administrator' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id, p.org_id, o.name, p.plan_key, p.seats, p.amount_cents, p.currency, p.status, p.provider, p.created_at, p.paid_at, u.email::text
  FROM payments p JOIN organizations o ON o.id = p.org_id LEFT JOIN users u ON u.id = p.created_by
  ORDER BY p.created_at DESC LIMIT 500;
END $$;
REVOKE ALL ON FUNCTION turf_platform_payments(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION turf_platform_payments(uuid) TO turf_app;
