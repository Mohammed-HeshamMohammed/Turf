-- Build step 30: protecting an agency's leads.
--   * Exports: the owner and admins export any leads; a team's leads export their own teams' only when the owner allows it; agents
--     never. Every export is kept with who, what and when (D162).
--   * Agents see only a lead's last four digits and call or text with a button (the dialer dials the CRM's number); the owner can show
--     full numbers per team; team leads, deputies, admins and the owner always see them (D163). The transaction says whether to mask
--     (cw.mask_phones) and for which teams numbers are shown in full (cw.full_team_ids).
--   * Who opened each lead and when, kept for the agency's chosen time, for the owner and admins (D165), and what a removed person looked
--     at recently (D264). Far more opening or paging than usual tells the owner and admins and slows that person for a while (D164).
--   Honest limit: a number an agent may call can still be written down by hand.

ALTER TABLE orgs ADD COLUMN managers_export boolean NOT NULL DEFAULT false;
ALTER TABLE orgs ADD COLUMN view_keep_days int NOT NULL DEFAULT 90 CHECK (view_keep_days BETWEEN 7 AND 730);
ALTER TABLE team_settings ADD COLUMN full_numbers boolean NOT NULL DEFAULT false;

CREATE FUNCTION crm.cw_phone_for(phone text, team uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN current_setting('cw.mask_phones', true) = 'on' AND coalesce(phone, '') <> ''
      AND NOT coalesce(team = ANY(nullif(current_setting('cw.full_team_ids', true), '')::uuid[]), false)
    THEN '••• ' || right(regexp_replace(phone, '\D', '', 'g'), 4) ELSE phone END
$$;
CREATE FUNCTION crm.cw_call_phone(phone text, lead uuid) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT crm.cw_phone_for(phone, (SELECT team_id FROM crm.leads WHERE id = lead))
$$;

CREATE TABLE lead_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  team_id uuid,
  rows int NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_exports_at ON lead_exports (org_id, at);

CREATE TABLE lead_views (
  org_id uuid NOT NULL,
  lead_id uuid NOT NULL,
  user_id uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_views_lead ON lead_views (lead_id, at);
CREATE INDEX lead_views_person ON lead_views (org_id, user_id, at);

-- How much each person opened and paged, per 10 minutes, to notice far more than usual.
CREATE TABLE access_counts (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bucket timestamptz NOT NULL,
  units int NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, user_id, bucket)
);

CREATE TABLE access_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  units int NOT NULL,
  usual int NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  slowed_until timestamptz NOT NULL,
  seen_by uuid
);
CREATE INDEX access_alerts_person ON access_alerts (org_id, user_id, slowed_until);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lead_exports', 'lead_views', 'access_counts', 'access_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
