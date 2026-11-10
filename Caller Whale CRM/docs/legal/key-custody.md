# Key custody procedure

The learning store's `LEARNING_HASH_KEY` (64 hex characters = 32 bytes) makes the scrambled codes of phone numbers and emails. Per-workspace keys are derived from it, so **one key protects every workspace**. If it is lost, stored codes can no longer be matched, flagged or erased by phone or email (rows can still be erased by workspace, list or expiry). If it leaks, whoever has it can test known phone numbers against the codes. The key is therefore a security control and, for the lawyer, part of why the codes count as pseudonymised rather than open.

## Rules

1. **Two owners** each hold a copy. Neither stores it in Coolify only, in chat, in email, in the repository or on a shared drive.
2. **Where:** a password manager's secure note with two-person access, plus one **printed sealed envelope** in a safe place, dated, signed over the flap. Write on the envelope: "Caller Whale learning key, version 1, made YYYY-MM-DD".
3. **Never typed into a form by anyone but an owner.** The Coolify environment variable `LEARNING_HASH_KEY` is set by an owner from the sealed copy.
4. **Make it** with the PowerShell in docs/plans/coolify-setup-crm-core.md or any cryptographic random source: 32 random bytes written as 64 hex characters.
5. **Test the backup:** once a quarter, an owner reads the backup copy and checks it against the first and last four characters of the running one (shown by the owner in Coolify, never in chat).

## Rotation (change of key)

Changing the key makes every old code unmatchable. Do it when the key may have leaked or when an owner who knew it leaves.

1. Switch learning off (`LEARNING_ENABLED=false`).
2. Erase the learning copy of every workspace (`DELETE /v1/workspaces/{org}` for each, then `POST /v1/workspaces/{org}/opt-in`), or truncate `learning.leads` (the audit table records the count).
3. Set the new key in Coolify, update both backups, destroy the old envelope.
4. Switch learning on; finished imports are copied again by crm-core only when they are new, so for a rebuild clear `importing.jobs.learned_at` for the lists you want copied again.

## Departures

When an owner leaves: rotate (above), change Coolify, Cloudflare, GitHub, Google and Paddle access, and remove their sessions.

## Record

| Version | Made | Owners holding it | Envelope location | Retired |
|---|---|---|---|---|
| 1 | [DATE] | [NAME], [NAME] | [PLACE] | |
