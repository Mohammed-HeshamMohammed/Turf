-- "Agents see the whole team's leads", read-only (D124), switched on per team by its leads, an admin or the owner. By default an
-- agent sees only their own leads.
ALTER TABLE team_settings ADD COLUMN IF NOT EXISTS agents_see_team boolean NOT NULL DEFAULT false;

-- cw_seen_lead is what a person may read: what they may work (cw_visible_lead), and the leads of their teams that let agents see the
-- whole team (cw.peek_team_ids, set per request). Only reading uses it; every change still asks cw_visible_lead, so the team view
-- never lets anyone change a teammate's lead.
CREATE OR REPLACE FUNCTION cw_seen_lead(p_lead uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT cw_visible_lead(p_lead) OR EXISTS (
    SELECT 1 FROM leads l WHERE l.id = p_lead AND l.org_id = cw_org() AND l.deleted_at IS NULL
      AND l.team_id = ANY(cw_uuids('cw.peek_team_ids'))
  )
$$;
