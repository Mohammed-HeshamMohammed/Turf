#!/usr/bin/env bash
# Copies everyone's account from the core API's database into the auth service's database, keeping the same ids,
# so a token from auth names the same person the core API already knows. Passwords (Argon2id), two-step secrets,
# recovery codes, confirmed emails and Google/Apple links use the same formats in both, so nobody has to reset
# anything or sign up again.
#
#   CORE_DATABASE_URL=postgres://callerwhale_owner:...@host/callerwhale \
#   AUTH_DATABASE_URL=postgres://callerwhale_auth:...@host/callerwhale_auth \
#   bash services/auth/scripts/import-from-core-api.sh
#
# Safe to run again: rows already in auth are kept (a confirmed email is filled in if auth did not have it). Run it
# after the auth service has started once on that database, so its tables are up to date. Checked against a local PostgreSQL (see services/auth/README.md); try it on a copy of
# production first.
set -euo pipefail

: "${CORE_DATABASE_URL:?set CORE_DATABASE_URL (the core API database, as its owner)}"
: "${AUTH_DATABASE_URL:?set AUTH_DATABASE_URL (the auth service database)}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# psql opens the files itself; on Windows (Git Bash) it needs a Windows path, not /tmp/...
files="$work"
if command -v cygpath >/dev/null 2>&1; then files="$(cygpath -m "$work")"; fi

echo "Reading accounts from the core API..."
psql "$CORE_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
\copy (SELECT id::text, lower(email::text), display_name, password_hash, totp_secret, totp_pending, CASE WHEN disabled_at IS NULL THEN NULL ELSE extract(epoch FROM disabled_at)::bigint END, extract(epoch FROM created_at)::bigint, CASE WHEN email_verified_at IS NULL THEN NULL ELSE extract(epoch FROM email_verified_at)::bigint END FROM users) TO '$files/users.csv' CSV
\copy (SELECT user_id::text, code_hash, CASE WHEN used_at IS NULL THEN NULL ELSE extract(epoch FROM used_at)::bigint END FROM recovery_codes) TO '$files/recovery.csv' CSV
\copy (SELECT provider, subject, user_id::text, lower(email::text), extract(epoch FROM created_at)::bigint FROM user_identities) TO '$files/identities.csv' CSV
SQL

echo "Writing them into auth..."
psql "$AUTH_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
CREATE TEMP TABLE incoming_users (LIKE users INCLUDING DEFAULTS) ON COMMIT DROP;
CREATE TEMP TABLE incoming_codes (LIKE recovery_codes INCLUDING DEFAULTS) ON COMMIT DROP;
CREATE TEMP TABLE incoming_identities (LIKE user_identities INCLUDING DEFAULTS) ON COMMIT DROP;
\copy incoming_users (id, email, display_name, password_hash, totp_secret, totp_pending, disabled_at, created_at, email_verified_at) FROM '$files/users.csv' CSV
\copy incoming_codes (user_id, code_hash, used_at) FROM '$files/recovery.csv' CSV
\copy incoming_identities (provider, subject, user_id, email, created_at) FROM '$files/identities.csv' CSV
-- An email auth already has under a different id is a different account (for example someone who signed up at auth
-- directly). It is left alone and listed, for a person to sort out; nothing is merged automatically.
SELECT 'skipped, email already used by another auth account: ' || i.email AS note
  FROM incoming_users i JOIN users u ON u.email = i.email AND u.id <> i.id;
INSERT INTO users (id, email, display_name, password_hash, totp_secret, totp_pending, disabled_at, created_at, email_verified_at)
  SELECT id, email, display_name, password_hash, totp_secret, totp_pending, disabled_at, created_at, email_verified_at FROM incoming_users i
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email AND u.id <> i.id)
  ON CONFLICT (id) DO UPDATE SET email_verified_at = coalesce(users.email_verified_at, EXCLUDED.email_verified_at);
INSERT INTO recovery_codes SELECT * FROM incoming_codes c WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = c.user_id)
  ON CONFLICT (user_id, code_hash) DO NOTHING;
INSERT INTO user_identities SELECT * FROM incoming_identities n WHERE EXISTS (SELECT 1 FROM users u WHERE u.id = n.user_id)
  ON CONFLICT (provider, subject) DO NOTHING;
COMMIT;
SQL

echo "Done: $(wc -l < "$work/users.csv") accounts, $(wc -l < "$work/recovery.csv") recovery codes and $(wc -l < "$work/identities.csv") Google/Apple links read."
