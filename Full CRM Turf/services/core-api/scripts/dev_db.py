"""Creates the development roles and databases on a PostgreSQL that has no psql on the PATH (for instance the portable
build from the @embedded-postgres npm package on Windows). Same result as the database half of dev-services.sh.

    python services/core-api/scripts/dev_db.py [port]

Needs `pip install "psycopg[binary]"`. Safe to run again: existing roles and databases are left alone.
"""

from __future__ import annotations

import sys

import psycopg

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 55432
ADMIN = f"host=127.0.0.1 port={PORT} user=postgres dbname=postgres"

with psycopg.connect(ADMIN, autocommit=True) as conn:
    if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname = 'turf_owner'").fetchone():
        conn.execute("CREATE ROLE turf_owner LOGIN PASSWORD 'turf_owner' CREATEROLE")
        conn.execute("CREATE ROLE turf_app NOLOGIN NOBYPASSRLS")
        conn.execute("CREATE ROLE turf_api LOGIN PASSWORD 'turf_api' NOBYPASSRLS IN ROLE turf_app")
        conn.execute("GRANT turf_app TO turf_owner WITH ADMIN OPTION")
    for name in ("turf", "turf_test"):
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            conn.execute(f"CREATE DATABASE {name} OWNER turf_owner")
            with psycopg.connect(f"host=127.0.0.1 port={PORT} user=postgres dbname={name}", autocommit=True) as db:
                db.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
                db.execute("CREATE EXTENSION IF NOT EXISTS citext")
                db.execute(f"GRANT CONNECT ON DATABASE {name} TO turf_app")

print(f"DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:{PORT}/turf")
print(f"MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:{PORT}/turf")
print(f"TEST_DATABASE_URL=postgres://turf_api:turf_api@127.0.0.1:{PORT}/turf_test")
print(f"TEST_MIGRATION_DATABASE_URL=postgres://turf_owner:turf_owner@127.0.0.1:{PORT}/turf_test")
