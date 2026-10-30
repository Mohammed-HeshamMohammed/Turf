-- Record scope, read from the request's settings (set by the API at the start of every transaction):
--   callerwhale.user_id, callerwhale.scopes (organization,team,project,own,shared), callerwhale.team_ids, callerwhale.project_ids.
-- Used by every lead-scoped query, search, count, export and pull (plan 2.4).

CREATE OR REPLACE FUNCTION callerwhale_setting_uuids(name text) RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting(name, true), '')::uuid[], '{}')
$$;

CREATE OR REPLACE FUNCTION callerwhale_visible_lead(p_lead uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT nullif(current_setting('callerwhale.user_id', true), '')::uuid AS id,
           string_to_array(coalesce(current_setting('callerwhale.scopes', true), ''), ',') AS scopes
  )
  SELECT EXISTS (
    SELECT 1 FROM leads l, me
    WHERE l.id = p_lead AND l.deleted_at IS NULL AND l.org_id = callerwhale_org() AND (
         'organization' = ANY(me.scopes)
      OR ('team' = ANY(me.scopes) AND l.team_id = ANY(callerwhale_setting_uuids('callerwhale.team_ids')))
      OR ('project' = ANY(me.scopes) AND l.project_id = ANY(callerwhale_setting_uuids('callerwhale.project_ids')))
      OR ('own' = ANY(me.scopes) AND (l.assignee_id = me.id
           OR EXISTS (SELECT 1 FROM handoffs h WHERE h.lead_id = l.id AND h.to_user = me.id AND h.status = 'Requested')))
      OR ('shared' = ANY(me.scopes) AND EXISTS (SELECT 1 FROM lead_shares s WHERE s.lead_id = l.id AND s.user_id = me.id))
    )
  )
$$;

-- Whether the request's user only sees explicitly shared records (an external client).
CREATE OR REPLACE FUNCTION callerwhale_external() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('callerwhale.scopes', true), '') = 'shared'
$$;
