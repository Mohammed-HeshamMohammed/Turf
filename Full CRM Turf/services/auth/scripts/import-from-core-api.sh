#!/usr/bin/env bash
# Copies everyone's account from the core API's database into the auth service's database, keeping the same ids,
# so a token from auth names the same person the core API already knows. Passwords (Argon2id), two-step secrets and
# recovery codes use the same formats in both, so nobody has to reset anything.
#
#   CORE_DATABASE_URL=postgres://turf_owner:...@host/turf \
#   AUTH_DATABASE_URL=postgres://turf_auth:...@host/turf_auth \
#   bash services/auth/scripts/import-from-core-api.sh
#
# Safe to run again: rows that are already in auth are left as they are. Run it with the auth service started once,
# so its tables exist. Checked against a local PostgreSQL (see services/auth/README.md); try it on a copy of
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
\copy (SELECT id::text, lower(email::text), display_name, password_hash, totp_secret, totp_pending, CASE WHEN disabled_at IS NULL THEN NULL ELSE extract(epoch FROM disabled_at)::bigint END, extract(epoch FROM created_at)::bigint FROM users) TO '$files/users.csv' CSV
\copy (SELECT user_id::text, code_hash, CASE WHEN used_at IS NULL THEN NULL ELSE extract(epoch FROM used_at)::bigint END FROM recovery_codes) TO '$files/recovery.csv' CSV
SQL

echo "Writing them into auth..."
psql "$AUTH_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<SQL
BEGIN;
CREATE TEMP TABLE incoming_users (LIKE users INCLUDING DEFAULTS) ON COMMIT DROP;
CREATE TEMP TABLE incoming_codes (LIKE recovery_codes INCLUDING DEFAULTS) ON COMMIT DROP;
\copy incoming_users (id, email, display_name, password_hash, totp_secret, totp_pending, disabled_at, created_at) FROM '$files/users.csv' CSV
\copy incoming_codes (user_id, code_hash, used_at) FROM '$files/recovery.csv' CSV
INSERT INTO users SELECT * FROM incoming_users ON CONFLICT (id) DO NOTHING;
INSERT INTO recovery_codes SELECT * FROM incoming_codes ON CONFLICT (user_id, code_hash) DO NOTHING;
COMMIT;
SQL

echo "Done: $(wc -l < "$work/users.csv") accounts and $(wc -l < "$work/recovery.csv") recovery codes read."
