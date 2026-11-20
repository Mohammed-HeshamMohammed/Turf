-- Why an invitation ended before it was accepted: withdrawn by the agency, its inviter lost the right to invite (D7, D13), the
-- invited person declined it (D68) or blocked the agency (D93), or a new invitation to the same address replaced an ended one.
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS revoked_reason TEXT NOT NULL DEFAULT '';
UPDATE access_invitations SET revoked_reason = 'withdrawn' WHERE revoked_at IS NOT NULL AND revoked_reason = '';
-- Resend and extend are limited (D175): resent at most once an hour and three times, extended twice.
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS resent_count INT NOT NULL DEFAULT 0;
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS extended_count INT NOT NULL DEFAULT 0;
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS last_sent_at BIGINT;
UPDATE access_invitations SET last_sent_at = created_at WHERE last_sent_at IS NULL;
CREATE INDEX IF NOT EXISTS access_invitations_org_created ON access_invitations(org_id, created_at);
CREATE INDEX IF NOT EXISTS access_invitations_inviter ON access_invitations(invited_by) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Each agency sets how long its invitations last (D41, 1 to 30 days, 7 by default). Staff can raise the daily number of new
-- invitations for a large agency (D176, 50 by default).
CREATE TABLE IF NOT EXISTS workspace_invitation_settings (
  org_id TEXT PRIMARY KEY,
  valid_days INT NOT NULL DEFAULT 7 CHECK (valid_days BETWEEN 1 AND 30),
  daily_cap INT NOT NULL DEFAULT 50 CHECK (daily_cap BETWEEN 1 AND 5000),
  updated_at BIGINT NOT NULL
);

-- A person who blocked an agency is never invited by it again (D93). Kept by address, the way invitations are sent.
CREATE TABLE IF NOT EXISTS invitation_blocks (
  email TEXT NOT NULL,
  org_id TEXT NOT NULL,
  org_name TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (email, org_id)
);
