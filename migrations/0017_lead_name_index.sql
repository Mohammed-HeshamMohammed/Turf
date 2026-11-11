-- The Leads list pages in name order; this index lets a page of a workspace of hundreds of thousands of leads come from the index.
CREATE INDEX IF NOT EXISTS leads_by_name ON crm.leads (org_id, name, id) WHERE deleted_at IS NULL;
