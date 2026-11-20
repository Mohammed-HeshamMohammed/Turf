-- Build step 23: clients. Every list and lead belongs to a client (D126); a list says who supplied it, the client or the agency. A lead
-- or list with no client is the agency's "own business", which every agency has. A team can work for several clients (D128); a client's
-- people see the leads the agency shared with their client (D127), never another client's (D223, D133).

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  own_business boolean NOT NULL DEFAULT false,
  approval_required boolean NOT NULL DEFAULT false,   -- the client approves the script and list summary before work starts (D138)
  ended_at timestamptz,                                -- stopped working with the agency (D132)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE UNIQUE INDEX clients_one_own_business ON clients (org_id) WHERE own_business;

-- The client's own people (client-role members of the workspace) and their main contact (D134).
CREATE TABLE client_members (
  org_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  main boolean NOT NULL DEFAULT false,
  PRIMARY KEY (client_id, user_id)
);
CREATE INDEX client_members_user ON client_members (org_id, user_id);

-- The clients a team works for (D128).
CREATE TABLE team_clients (
  org_id uuid NOT NULL,
  team_id uuid NOT NULL,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, client_id)
);

ALTER TABLE projects ADD COLUMN client_id uuid REFERENCES clients(id);
ALTER TABLE projects ADD COLUMN supplied_by text NOT NULL DEFAULT 'agency' CHECK (supplied_by IN ('agency', 'client'));
ALTER TABLE leads ADD COLUMN client_id uuid REFERENCES clients(id);
ALTER TABLE leads ADD COLUMN shared_with_client boolean NOT NULL DEFAULT false;  -- the agency shared this lead with its client's people
CREATE INDEX leads_client ON leads (org_id, client_id) WHERE deleted_at IS NULL;

-- A new lead belongs to its list's client unless it was given one.
CREATE FUNCTION crm.lead_client() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.client_id IS NULL AND NEW.project_id IS NOT NULL THEN
    SELECT client_id INTO NEW.client_id FROM crm.projects WHERE id = NEW.project_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_client BEFORE INSERT ON leads FOR EACH ROW EXECUTE FUNCTION crm.lead_client();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['clients', 'client_members', 'team_clients'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;

-- A client's people see the leads shared with their client (D127), besides any shared with them one by one.
CREATE OR REPLACE FUNCTION cw_visible_lead(p_lead uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT nullif(current_setting('cw.user_id', true), '')::uuid AS id,
           string_to_array(coalesce(current_setting('cw.scopes', true), ''), ',') AS scopes
  )
  SELECT EXISTS (
    SELECT 1 FROM leads l, me
    WHERE l.id = p_lead AND l.deleted_at IS NULL AND l.org_id = cw_org() AND (
         'organization' = ANY(me.scopes)
      OR ('team' = ANY(me.scopes) AND l.team_id = ANY(cw_uuids('cw.team_ids')))
      OR ('project' = ANY(me.scopes) AND l.project_id = ANY(cw_uuids('cw.project_ids')))
      OR ('own' = ANY(me.scopes) AND (l.assignee_id = me.id
           OR EXISTS (SELECT 1 FROM handoffs h WHERE h.lead_id = l.id AND h.to_user = me.id AND h.status = 'Requested')))
      OR ('shared' = ANY(me.scopes) AND (EXISTS (SELECT 1 FROM lead_shares s WHERE s.lead_id = l.id AND s.user_id = me.id)
           OR (l.shared_with_client AND EXISTS (SELECT 1 FROM client_members cm WHERE cm.client_id = l.client_id AND cm.user_id = me.id))))
    )
  )
$$;

-- Imports compare a list only with the leads of the same client (D133, D223): each import job knows its list's client, and the lead
-- keys the import service reads carry the lead's.
ALTER TABLE importing.jobs ADD COLUMN client_id uuid;
CREATE POLICY matching_read ON projects FOR SELECT USING (current_setting('cw.matching', true) = 'on');
CREATE FUNCTION importing.job_client() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = crm, importing, public AS $$
DECLARE before text := current_setting('cw.matching', true);
BEGIN
  IF NEW.project_id IS NOT NULL THEN
    PERFORM set_config('cw.matching', 'on', true);
    SELECT client_id INTO NEW.client_id FROM crm.projects WHERE id = NEW.project_id AND org_id = NEW.org_id;
    PERFORM set_config('cw.matching', coalesce(before, ''), true);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER jobs_client BEFORE INSERT ON importing.jobs FOR EACH ROW EXECUTE FUNCTION importing.job_client();
CREATE OR REPLACE VIEW importing.lead_match AS
  SELECT l.id, l.org_id, l.name, importing.norm_phone(l.phone) AS phone, nullif(lower(btrim(l.email)), '') AS email,
         importing.addr_key(p.address, p.postal_code) AS addr_key, l.client_id
  FROM crm.leads l LEFT JOIN crm.properties p ON p.id = l.property_id
  WHERE l.deleted_at IS NULL;
