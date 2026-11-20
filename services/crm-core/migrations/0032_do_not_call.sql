-- Build step 25: "do not call" by number, in three kinds (D139, D363).
--   * Asked this agency to stop: the agency's own block list, for every client and team and every later import. A block says what it
--     stops, calls, texts or both (D209, D351), and only the owner or an admin lifts it, with a reason (D207, D113).
--   * Wants no calls from anyone, or a confirmed known complainer: Caller Whale's own database, read by every agency. "No calls from
--     anyone" counts once the agent confirms it (D351); a complainer once a second agency reports the number or staff check it (D139).
--     Registry numbers are never copied here: each agency checks the registries through its own access (D363, D274).
--   * Every mark says who, when, which agency and which lead; only Caller Whale staff remove a number from the database, an agency asks
--     for a review with a reason, and each removal is kept (D141).
-- Blocks belong to a number, never to a lead's other numbers (D357).

-- A phone number's key: its last ten digits, how a US number is matched whatever its formatting; NULL when it is too short to be one.
CREATE FUNCTION crm.phone_key(raw text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) >= 7 THEN right(d, 10) END FROM (SELECT regexp_replace(coalesce(raw, ''), '\D', '', 'g') AS d) x
$$;

CREATE TABLE number_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  phone_key text NOT NULL,
  calls boolean NOT NULL,
  texts boolean NOT NULL,
  reason text NOT NULL CHECK (reason IN ('asked_agency', 'opt_out_reply', 'deleted_on_request', 'other')),
  source text NOT NULL DEFAULT '' CHECK (source IN ('', 'lead', 'call', 'text', 'import', 'list')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
  lead_id uuid,
  marked_by uuid,                       -- NULL when the lead did it themselves (an opt-out reply)
  marked_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by uuid,
  lift_reason text NOT NULL DEFAULT '' CHECK (length(lift_reason) <= 500),
  CHECK (calls OR texts)
);
CREATE UNIQUE INDEX number_blocks_active ON number_blocks (org_id, phone_key) WHERE lifted_at IS NULL;
ALTER TABLE number_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE number_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON number_blocks USING (org_id = cw_org()) WITH CHECK (org_id = cw_org());

-- Caller Whale's database. Shared by every agency on purpose, so it has no row security: the service reads it only by number, and
-- shows who marked a number to Caller Whale staff alone.
CREATE TABLE shared_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('no_calls_anyone', 'complainer')),
  confirmed_at timestamptz,             -- blocks every agency from then on
  confirmed_how text NOT NULL DEFAULT '' CHECK (confirmed_how IN ('', 'agent', 'second_agency', 'staff')),
  confirmed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by uuid,
  remove_reason text NOT NULL DEFAULT '' CHECK (length(remove_reason) <= 1000)
);
CREATE UNIQUE INDEX shared_blocks_active ON shared_blocks (phone_key) WHERE removed_at IS NULL;

-- Who marked what (the record of D141 and the watch on anyone marking unusually many).
CREATE TABLE shared_block_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL REFERENCES shared_blocks(id),
  org_id uuid NOT NULL,
  user_id uuid,
  lead_id uuid,
  kind text NOT NULL,
  note text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shared_block_marks_block ON shared_block_marks (block_id);
CREATE INDEX shared_block_marks_recent ON shared_block_marks (user_id, at);

-- An agency asks Caller Whale to look again at a number in the database (D141).
CREATE TABLE shared_block_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id uuid NOT NULL REFERENCES shared_blocks(id),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
  at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  decision text NOT NULL DEFAULT '' CHECK (decision IN ('', 'removed', 'kept')),
  staff_note text NOT NULL DEFAULT ''
);
CREATE INDEX shared_block_reviews_open ON shared_block_reviews (at) WHERE decided_at IS NULL;

-- A lead whose number is blocked for calls is do-not-call from the moment it is added or its number changes: an import, a form or a
-- hand-made lead never brings a blocked number back.
CREATE FUNCTION crm.lead_blocked() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text := crm.phone_key(NEW.phone);
BEGIN
  IF NOT NEW.do_not_call AND k IS NOT NULL AND (
       EXISTS (SELECT 1 FROM crm.number_blocks b WHERE b.org_id = NEW.org_id AND b.phone_key = k AND b.calls AND b.lifted_at IS NULL)
    OR EXISTS (SELECT 1 FROM crm.shared_blocks s WHERE s.phone_key = k AND s.confirmed_at IS NOT NULL AND s.removed_at IS NULL)) THEN
    NEW.do_not_call := true;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_blocked BEFORE INSERT OR UPDATE OF phone ON leads FOR EACH ROW EXECUTE FUNCTION crm.lead_blocked();

-- An agency confirms on import that it holds consent to text a list's numbers; the confirmation covers that agency and that list's
-- client only (D355, D366).
ALTER TABLE projects ADD COLUMN text_consent_at timestamptz;
ALTER TABLE projects ADD COLUMN text_consent_by uuid;
