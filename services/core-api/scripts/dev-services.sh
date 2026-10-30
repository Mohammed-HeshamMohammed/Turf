#!/usr/bin/env bash
# Starts a local PostgreSQL and Redis for development and tests, with data outside the repository.
#   CALLERWHALE_DATA (default /x/callerwhale-data)   CALLERWHALE_TOOLS env script (default /x/tools/env.sh)
# Roles: callerwhale_owner (owns the schema, runs migrations) and callerwhale_api (the API's login, member of callerwhale_app; row security applies).
set -euo pipefail
[ -f "${CALLERWHALE_TOOLS:-/x/tools/env.sh}" ] && source "${CALLERWHALE_TOOLS:-/x/tools/env.sh}"
DATA="${CALLERWHALE_DATA:-/x/callerwhale-data}"
PGPORT="${CALLERWHALE_PG_PORT:-55432}"
REDIS_PORT="${CALLERWHALE_REDIS_PORT:-56379}"
mkdir -p "$DATA"
if [ ! -f "$DATA/pg/PG_VERSION" ]; then
  initdb -D "$DATA/pg" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
fi
if ! pg_ctl -D "$DATA/pg" status >/dev/null 2>&1; then
  pg_ctl -D "$DATA/pg" -o "-p $PGPORT -c listen_addresses=127.0.0.1" -l "$DATA/pg.log" -w start >/dev/null
fi
psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAc "SELECT 1 FROM pg_roles WHERE rolname='callerwhale_owner'" | grep -q 1 || \
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE ROLE callerwhale_owner LOGIN PASSWORD 'callerwhale_owner' CREATEROLE; CREATE ROLE callerwhale_app NOLOGIN NOBYPASSRLS; CREATE ROLE callerwhale_api LOGIN PASSWORD 'callerwhale_api' NOBYPASSRLS IN ROLE callerwhale_app; GRANT callerwhale_app TO callerwhale_owner WITH ADMIN OPTION;"
for db in callerwhale callerwhale_test; do
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || \
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE DATABASE $db OWNER callerwhale_owner; " -c "\c $db" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; GRANT CONNECT ON DATABASE $db TO callerwhale_app;"
done
if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  (cd "$DATA" && nohup redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save "" --appendonly no >"$DATA/redis.log" 2>&1 &)
  sleep 1
fi
cat <<OUT
DATABASE_URL=postgres://callerwhale_api:callerwhale_api@127.0.0.1:$PGPORT/callerwhale
MIGRATION_DATABASE_URL=postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:$PGPORT/callerwhale
TEST_DATABASE_URL=postgres://callerwhale_api:callerwhale_api@127.0.0.1:$PGPORT/callerwhale_test
TEST_MIGRATION_DATABASE_URL=postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:$PGPORT/callerwhale_test
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
OUT
