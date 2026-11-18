-- Build step 31: first setup, walk-throughs and the agency's own material.
--   * A new agency's owner meets a short setup: the agency's name and hours, a first team, a first client (or "own business"), inviting
--     people, the authenticator, and the data processing agreement. Each step can be skipped and finished later from the checklist
--     (D170, D308). Steps the CRM can see for itself count as done without being marked.
--   * Each person finishes a short walk-through of their role's screens once per agency (D173).
--   * The owner, admins and team leads add the agency's own material (a link or a text), assign it, and see who finished it (D173).

CREATE TABLE setup_steps (
  org_id uuid NOT NULL,
  step text NOT NULL,
  status text NOT NULL CHECK (status IN ('done', 'skipped')),
  set_by uuid,
  set_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, step)
);

CREATE TABLE agreements (
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dpa')),
  version text NOT NULL,
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, kind, version)
);

CREATE TABLE walkthroughs (
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, role)
);

CREATE TABLE material (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  url text NOT NULL DEFAULT '' CHECK (url = '' OR url ~ '^https://'),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 50000),
  team_id uuid,                           -- a team's own, made by its leads; NULL: the agency's
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (url <> '' OR body <> '')
);

CREATE TABLE material_assignments (
  org_id uuid NOT NULL,
  material_id uuid NOT NULL REFERENCES material(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  assigned_by uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (material_id, user_id)
);
CREATE INDEX material_assignments_person ON material_assignments (org_id, user_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['setup_steps', 'agreements', 'walkthroughs', 'material', 'material_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY org_isolation ON %I USING (org_id = cw_org()) WITH CHECK (org_id = cw_org())', t);
  END LOOP;
END $$;
