-- #Owner and #Co-Owner belong to the platform owner and the cofounder only (authz keeps exactly one of each, for good). Chosen tags
-- can never spell them (no O, no hyphen); here the database makes sure of the rest: each is held by one person at most, whatever
-- their name, and only the auth service's founder step writes one, by naming that person for that one update (founder_tags.go).
CREATE UNIQUE INDEX users_founder_tag ON users (tag) WHERE tag IN ('Owner', 'Co-Owner');

CREATE FUNCTION users_founder_tag_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tag IN ('Owner', 'Co-Owner') AND (TG_OP = 'INSERT' OR NEW.tag IS DISTINCT FROM OLD.tag)
     AND current_setting('callerwhale.founder_tag', true) IS DISTINCT FROM NEW.id THEN
    RAISE EXCEPTION 'the #Owner and #Co-Owner tags belong to the platform owner and cofounder';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER users_founder_tag_guard BEFORE INSERT OR UPDATE OF tag ON users FOR EACH ROW EXECUTE FUNCTION users_founder_tag_guard();
