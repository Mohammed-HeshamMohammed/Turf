#!/usr/bin/env bash
# Starts a local PostgreSQL and Redis for development and tests, with data outside the repository.
#   TURF_DATA (default /x/turf-data)   TURF_TOOLS env script (default /x/tools/env.sh)
# Roles: turf_owner (owns the schema, runs migrations) and turf_api (the API's login, member of turf_app; row security applies).
set -euo pipefail
[ -f "${TURF_TOOLS:-/x/tools/env.sh}" ] && source "${TURF_TOOLS:-/x/tools/env.sh}"
DATA="${TURF_DATA:-/x/turf-data}"
PGPORT="${TURF_PG_PORT:-55432}"
REDIS_PORT="${TURF_REDIS_PORT:-56379}"
mkdir -p "$DATA"
if [ ! -f "$DATA/pg/PG_VERSION" ]; then
  initdb -D "$DATA/pg" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
fi
if ! pg_ctl -D "$DATA/pg" status >/dev/null 2>&1; then
  pg_ctl -D "$DATA/pg" -o "-p $PGPORT -c listen_addresses=127.0.0.1" -l "$DATA/pg.log" -w start >/dev/null
fi
psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAc "SELECT 1 FROM pg_roles WHERE rolname='turf_owner'" | grep -q 1 || \
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE ROLE turf_owner LOGIN PASSWORD 'turf_owner' CREATEROLE; CREATE ROLE turf_app NOLOGIN NOBYPASSRLS; CREATE ROLE turf_api LOGIN PASSWORD 'turf_api' NOBYPASSRLS IN ROLE turf_app; GRANT turf_app TO turf_owner WITH ADMIN OPTION;"
for db in turf turf_test; do
  psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qtAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || \
    psql -h 127.0.0.1 -p "$PGPORT" -U postgres -qc "CREATE DATABASE $db OWNER turf_owner; " -c "\c $db" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext; GRANT CONNECT ON DATABASE $db TO turf_app;"
done
if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
  (cd "$DATA" && nohup redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save "" --appendonly no >"$DATA/redis.log" 2>&1 &)
  sleep 1
fi
cat <<OUT
DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:$PGPORT/turf
MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:$PGPORT/turf
TEST_DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:$PGPORT/turf_test
TEST_MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:$PGPORT/turf_test
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
OUT
