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
    if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname = 'callerwhale_owner'").fetchone():
        conn.execute("CREATE ROLE callerwhale_owner LOGIN PASSWORD 'callerwhale_owner' CREATEROLE")
        conn.execute("CREATE ROLE callerwhale_app NOLOGIN NOBYPASSRLS")
        conn.execute("CREATE ROLE callerwhale_api LOGIN PASSWORD 'callerwhale_api' NOBYPASSRLS IN ROLE callerwhale_app")
        conn.execute("GRANT callerwhale_app TO callerwhale_owner WITH ADMIN OPTION")
    for name in ("callerwhale", "callerwhale_test"):
        if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
            conn.execute(f"CREATE DATABASE {name} OWNER callerwhale_owner")
            with psycopg.connect(f"host=127.0.0.1 port={PORT} user=postgres dbname={name}", autocommit=True) as db:
                db.execute("CREATE EXTENSION IF NOT EXISTS pgcrypto")
                db.execute("CREATE EXTENSION IF NOT EXISTS citext")
                db.execute(f"GRANT CONNECT ON DATABASE {name} TO callerwhale_app")

print(f"DATABASE_URL=postgres://callerwhale_api:callerwhale_api@127.0.0.1:{PORT}/callerwhale")
print(f"MIGRATION_DATABASE_URL=postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:{PORT}/callerwhale")
print(f"TEST_DATABASE_URL=postgres://callerwhale_api:callerwhale_api@127.0.0.1:{PORT}/callerwhale_test")
print(f"TEST_MIGRATION_DATABASE_URL=postgres://callerwhale_owner:callerwhale_owner@127.0.0.1:{PORT}/callerwhale_test")
