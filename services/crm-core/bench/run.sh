#!/bin/bash
# Starts a private PostgreSQL 17 (only this container can reach it), runs the merge speed test once, prints the results and the
# slowest statements, then waits, so the log stays readable in Coolify until the app is deleted.
set -u
export PGDATA=/var/lib/postgresql/bench
echo "== machine: $(nproc) CPUs, $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo) memory; $(date -u)"
mkdir -p "$PGDATA" && chown postgres "$PGDATA"
gosu postgres initdb -U postgres --auth=trust >/dev/null
gosu postgres pg_ctl -D "$PGDATA" -l /tmp/pg.log -w start -o "-c listen_addresses=127.0.0.1 \
  -c shared_preload_libraries=pg_stat_statements,auto_explain -c pg_stat_statements.track=all \
  -c auto_explain.log_min_duration=${EXPLAIN_MS} -c auto_explain.log_analyze=on -c auto_explain.log_buffers=on \
  -c auto_explain.log_nested_statements=on"
psql -q -U postgres -h 127.0.0.1 <<'SQL'
CREATE ROLE crm_app LOGIN PASSWORD 'apppass' NOSUPERUSER NOBYPASSRLS;
CREATE DATABASE crm_test;
\c crm_test
GRANT ALL ON DATABASE crm_test TO crm_app;
GRANT ALL ON SCHEMA public TO crm_app;
CREATE EXTENSION pg_stat_statements;
SQL
echo "== postgres: $(psql -At -U postgres -h 127.0.0.1 -c 'SHOW server_version') shared_buffers=$(psql -At -U postgres -h 127.0.0.1 -c 'SHOW shared_buffers') work_mem=$(psql -At -U postgres -h 127.0.0.1 -c 'SHOW work_mem')"
export CRM_TEST_ADMIN_URL="postgres://postgres@127.0.0.1:5432/crm_test?sslmode=disable"
export CRM_TEST_DATABASE_URL="postgres://crm_app:apppass@127.0.0.1:5432/crm_test?sslmode=disable"
cd /bench && ./crm-core.test -test.run '^TestMergeAtScale$' -test.v -test.timeout 3h 2>&1 | grep -v '^\[' | grep -E 'merge_scale_test|PASS|FAIL|ok|panic|Error' 
echo "== slowest statements (total time)"
psql -U postgres -h 127.0.0.1 -d crm_test -P pager=off -c "SELECT round(total_exec_time/1000, 1) AS total_s, calls, round(mean_exec_time::numeric, 2) AS mean_ms,
  left(regexp_replace(query, '\s+', ' ', 'g'), 160) AS statement FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%'
  ORDER BY total_exec_time DESC LIMIT 15"
echo "== plans of statements slower than ${EXPLAIN_MS} ms"
grep -A70 'duration: .* plan:' /tmp/pg.log | grep -v '^\s*$' | head -600
echo "== done; delete this app in Coolify"
exec sleep infinity
