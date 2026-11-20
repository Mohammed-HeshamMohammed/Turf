-- An invitation says where it comes from: the agency's name and its owner's name as they were when it was sent.
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS org_name TEXT NOT NULL DEFAULT '';
ALTER TABLE access_invitations ADD COLUMN IF NOT EXISTS owner_name TEXT NOT NULL DEFAULT '';

-- "Report this invitation": the invited person tells Caller Whale staff an invitation looks wrong. One report per person and
-- invitation; staff read them.
CREATE TABLE IF NOT EXISTS invitation_reports (
  invitation_id TEXT NOT NULL REFERENCES access_invitations(id),
  reporter_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (invitation_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS invitation_reports_new ON invitation_reports(created_at DESC);
