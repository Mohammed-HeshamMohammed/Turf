-- An authenticator code works once (RFC 6238 section 5.2): the time step of the last code accepted for a device, so the same code
-- cannot be used again while it is still inside the clock-drift window.
ALTER TABLE mfa_factors ADD COLUMN last_step BIGINT;
