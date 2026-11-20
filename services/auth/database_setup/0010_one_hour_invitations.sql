-- Earlier versions allowed seven days. Cap every still-pending invitation at one hour from creation.
-- Expired rows remain for audit and are withdrawn when the address is invited again.
UPDATE access_invitations SET expires_at = created_at + 3600
WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > created_at + 3600;
