-- Build step 38: file storage on leads per plan, in MB (D257, D289). About 2 GB a seat; more storage is priced as its own feature
-- later. NULL is unlimited; staff can override it per workspace like the other limits.
ALTER TABLE billing.plan_limits DROP CONSTRAINT IF EXISTS plan_limits_key_check;
ALTER TABLE billing.plan_limits ADD CONSTRAINT plan_limits_key_check CHECK (key IN ('clients', 'active_leads', 'imports_monthly', 'skiptrace_credits', 'file_storage_mb'));
ALTER TABLE billing.org_limit_overrides DROP CONSTRAINT IF EXISTS org_limit_overrides_key_check;
ALTER TABLE billing.org_limit_overrides ADD CONSTRAINT org_limit_overrides_key_check
  CHECK (key IN ('seats', 'clients', 'active_leads', 'imports_monthly', 'monthly_minutes', 'skiptrace_credits', 'file_storage_mb'));
INSERT INTO billing.plan_limits (plan_key, key, value) VALUES
  ('trial', 'file_storage_mb', 100), ('solo', 'file_storage_mb', 2048), ('duo', 'file_storage_mb', 4096),
  ('team', 'file_storage_mb', 6144), ('pro', 'file_storage_mb', 15360), ('custom', 'file_storage_mb', 0)
ON CONFLICT DO NOTHING;
