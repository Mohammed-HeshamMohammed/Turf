-- Build step 4 (with step 15's limits): a #tag after every name, so two people never look the same (D5, D14, D186), the three
-- settings each person controls (D3, D30), and limits on changing the name and the tag (D29).
--
-- The full name is display_name#tag, for example Alex Morgan#K7P2. Name and tag together are unique, with look-alike characters
-- counted as the same (name_key). A tag uses letters and digits without 0, O, 1 and I. A name or tag someone stopped using is held for
-- 90 days so nobody else can take it and pose as them.

CREATE FUNCTION name_key(n text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT translate(lower(regexp_replace(btrim(coalesce(n, '')), '\s+', ' ', 'g')), '01l|', 'oiii')
$$;

CREATE FUNCTION random_tag() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') FROM generate_series(1, 4)
$$;

ALTER TABLE users ADD COLUMN name_key TEXT;
ALTER TABLE users ADD COLUMN tag TEXT;
-- Existing people see a one-time note about their new tag in settings (D106); people who sign up from now on do not need one.
ALTER TABLE users ADD COLUMN tag_note_seen BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ALTER COLUMN tag_note_seen SET DEFAULT true;
-- Who can see my phone number: nobody, my agencies' owners, admins and team leads, or everyone in my agencies (D3, D22).
ALTER TABLE users ADD COLUMN phone_visible TEXT NOT NULL DEFAULT 'nobody' CHECK (phone_visible IN ('nobody', 'leads', 'agencies'));
-- Who can find me: by name in my agencies, and anyone else by my exact Name#tag ('exact', the default, D30); or my agencies only.
ALTER TABLE users ADD COLUMN find_me TEXT NOT NULL DEFAULT 'exact' CHECK (find_me IN ('exact', 'agencies'));
-- Who can message me outside an agency: anyone who finds me, with a request first (the default); people in my agencies; nobody.
ALTER TABLE users ADD COLUMN message_me TEXT NOT NULL DEFAULT 'requests' CHECK (message_me IN ('requests', 'agencies', 'nobody'));

CREATE TABLE retired_names (
  name_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until BIGINT NOT NULL,
  PRIMARY KEY (name_key, tag, user_id)
);

-- Each change of name or tag the person makes, for the limit of two of each in 30 days.
CREATE TABLE name_changes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  what TEXT NOT NULL CHECK (what IN ('name', 'tag')),
  at BIGINT NOT NULL
);
CREATE INDEX name_changes_by_person ON name_changes (user_id, what, at);

-- Exact Name#tag look-ups, counted so nobody can list every user by guessing.
CREATE TABLE people_lookups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at BIGINT NOT NULL
);
CREATE INDEX people_lookups_by_person ON people_lookups (user_id, at);

CREATE FUNCTION tag_taken(k text, t text, me text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
  SELECT EXISTS (SELECT 1 FROM users u WHERE u.name_key = k AND u.tag = t AND u.id <> me)
      OR EXISTS (SELECT 1 FROM retired_names r WHERE r.name_key = k AND r.tag = t AND r.user_id <> me AND r.until > extract(epoch FROM now())::bigint)
$$;

-- Keeps name_key with the name, and gives a tag when there is none or when a new name would make the full name someone else's (the
-- person keeps their name and gets a free tag). A tag the person chose is checked by the service before it is saved.
CREATE FUNCTION users_name_tag() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.name_key := name_key(NEW.display_name);
  IF NEW.tag IS NULL OR (TG_OP = 'INSERT' AND tag_taken(NEW.name_key, NEW.tag, NEW.id))
     OR (TG_OP = 'UPDATE' AND NEW.name_key IS DISTINCT FROM OLD.name_key AND NEW.tag = OLD.tag AND tag_taken(NEW.name_key, NEW.tag, NEW.id)) THEN
    LOOP
      NEW.tag := random_tag();
      EXIT WHEN NOT tag_taken(NEW.name_key, NEW.tag, NEW.id);
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

-- The full name a person stops using is held for them for 90 days.
CREATE FUNCTION users_retire_name() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.tag IS NOT NULL AND (NEW.name_key IS DISTINCT FROM OLD.name_key OR NEW.tag IS DISTINCT FROM OLD.tag) THEN
    INSERT INTO retired_names (name_key, tag, user_id, until) VALUES (OLD.name_key, OLD.tag, OLD.id, extract(epoch FROM now())::bigint + 90 * 86400)
    ON CONFLICT (name_key, tag, user_id) DO UPDATE SET until = EXCLUDED.until;
  END IF;
  RETURN NULL;
END $$;

-- Everyone already here gets a tag; nobody's name changes.
DO $$
DECLARE r record;
DECLARE t text;
DECLARE k text;
BEGIN
  FOR r IN SELECT id, display_name FROM users ORDER BY created_at, id LOOP
    k := name_key(r.display_name);
    LOOP
      t := random_tag();
      EXIT WHEN NOT tag_taken(k, t, r.id);
    END LOOP;
    UPDATE users SET name_key = k, tag = t WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE users ALTER COLUMN tag SET NOT NULL;
CREATE UNIQUE INDEX users_name_tag ON users (name_key, tag);

CREATE TRIGGER users_name_tag BEFORE INSERT OR UPDATE OF display_name, tag ON users FOR EACH ROW EXECUTE FUNCTION users_name_tag();
CREATE TRIGGER users_retire_name AFTER UPDATE OF display_name, tag ON users FOR EACH ROW EXECUTE FUNCTION users_retire_name();
