-- The snapshot reads a workspace's most recently changed leads, newest first, and stops after the first few hundred: this index lets it
-- do that without looking at every lead of a workspace that holds hundreds of thousands.
CREATE INDEX IF NOT EXISTS leads_recent ON crm.leads (org_id, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
