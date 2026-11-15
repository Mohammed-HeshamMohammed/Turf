-- Memberships the platform owner or cofounder gives (a trial, free, or paid outside a payment provider), kept here while no
-- billing service is connected. One row per workspace. limits is JSON: the plan's limits with the staff's changes, null for
-- unlimited. expired_told is when authorization was told the period ended, so it is told once.
CREATE TABLE IF NOT EXISTS workspace_memberships (
  org_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL,
  payment TEXT NOT NULL CHECK (payment IN ('trial', 'free', 'manual')),
  status TEXT NOT NULL CHECK (status IN ('trialing', 'active')),
  period_start BIGINT NOT NULL,
  period_end BIGINT NOT NULL,
  paid_minor BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  limits TEXT NOT NULL DEFAULT '{}',
  given_by TEXT NOT NULL,
  given_at BIGINT NOT NULL,
  expired_told BIGINT
);
CREATE INDEX IF NOT EXISTS workspace_memberships_due ON workspace_memberships(period_end) WHERE expired_told IS NULL;
