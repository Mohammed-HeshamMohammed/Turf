-- Lead search (leads.go searchLeads) looks for a few letters or digits anywhere in a name, phone, email or address. Trigram indexes let
-- that use an index instead of reading every lead. pg_trgm is a trusted extension (the database's owner may add it); where it cannot be
-- added, nothing fails: search still works, only slower.
DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
    RAISE NOTICE 'pg_trgm is not available: lead search works without its indexes';
  END;
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS leads_name_trgm ON crm.leads USING gin (name gin_trgm_ops) WHERE deleted_at IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS leads_email_trgm ON crm.leads USING gin (email gin_trgm_ops) WHERE deleted_at IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS leads_phone_digits_trgm ON crm.leads USING gin ((regexp_replace(phone, ''[^0-9]'', '''', ''g'')) gin_trgm_ops) WHERE deleted_at IS NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS properties_address_trgm ON crm.properties USING gin (address gin_trgm_ops)';
  END IF;
END $$;
-- City and ZIP are matched from their start, which an ordinary index serves.
CREATE INDEX IF NOT EXISTS properties_city_prefix ON crm.properties (org_id, lower(city) text_pattern_ops) WHERE city <> '';
CREATE INDEX IF NOT EXISTS properties_zip_prefix ON crm.properties (org_id, postal_code text_pattern_ops) WHERE postal_code <> '';
-- The Leads page lists the newest leads first, so an import's leads show at the top as each batch is added.
CREATE INDEX IF NOT EXISTS leads_newest ON crm.leads (org_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
