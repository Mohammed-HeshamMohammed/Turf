-- Each property keeps its address key (importing.addr_key) in a column (merge speed work). Row security keeps PostgreSQL from using the
-- expression index properties_addr_key in crm-core's own queries (importing.addr_key is not "leakproof"), so linking an import's
-- co-owners worked the key out again for every property of the agency, each import: 116 s of a 100,000-row merge at 270,000
-- properties, measured on the Coolify server. A plain column can be indexed and compared under row security.
-- '' means the address has no key; NULL means it is not worked out yet. crm-core fills those in the background, a batch at a time
-- (the upkeep task address_keys), and the trigger keeps every new or changed address's key from now on.
ALTER TABLE properties ADD COLUMN IF NOT EXISTS addr_key text;

CREATE OR REPLACE FUNCTION crm.keep_addr_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.addr_key := coalesce(importing.addr_key(NEW.address, NEW.postal_code), '');
  RETURN NEW;
END $$;
CREATE TRIGGER properties_addr_key BEFORE INSERT OR UPDATE OF address, postal_code ON properties
  FOR EACH ROW EXECUTE FUNCTION crm.keep_addr_key();

-- The import worker's view of the leads reads the stored key too, and works it out only where it is not filled in yet.
CREATE OR REPLACE VIEW importing.lead_match AS
  SELECT l.id, l.org_id, l.name, importing.norm_phone(l.phone) AS phone, nullif(lower(btrim(l.email)), '') AS email,
         CASE WHEN p.addr_key IS NULL THEN importing.addr_key(p.address, p.postal_code) ELSE nullif(p.addr_key, '') END AS addr_key, l.client_id
  FROM crm.leads l LEFT JOIN crm.properties p ON p.id = l.property_id
  WHERE l.deleted_at IS NULL;
