"""The billing database: the connection pool, and the numbered setup scripts in database_setup/ applied once each, in order,
under a lock, refusing to start if one already applied has changed."""

import hashlib
from pathlib import Path

from psycopg_pool import ConnectionPool

SETUP_DIR = Path(__file__).resolve().parent.parent / "database_setup"
# Any number, the same in every copy of billing: only one copy applies setup scripts at a time.
SETUP_LOCK = 7_310_210_301


class SetupError(RuntimeError):
    pass


def scripts(directory: Path = SETUP_DIR) -> list[tuple[int, str, str]]:
    """(version, name, sql) for every numbered script, in order."""
    found = []
    for path in sorted(directory.glob("[0-9][0-9][0-9][0-9]_*.sql")):
        found.append((int(path.name[:4]), path.name, path.read_text(encoding="utf-8")))
    versions = [v for v, _, _ in found]
    if len(versions) != len(set(versions)):
        raise SetupError("two database setup scripts share a number")
    return found


def checksum(sql: str) -> str:
    return hashlib.sha256(sql.replace("\r\n", "\n").encode("utf-8")).hexdigest()


def apply_setup(pool: ConnectionPool, directory: Path = SETUP_DIR) -> list[str]:
    """Applies the scripts not applied yet; returns their names."""
    applied = []
    with pool.connection() as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (SETUP_LOCK,))
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS public.billing_setup_history (version integer PRIMARY KEY, name text NOT NULL, "
                "checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"
            )
            conn.commit()
            done = {v: (n, c) for v, n, c in conn.execute("SELECT version, name, checksum FROM public.billing_setup_history").fetchall()}
            for version, name, sql in scripts(directory):
                if version in done:
                    if done[version][1] != checksum(sql):
                        raise SetupError(f"{name} was changed after it was applied: add a new numbered script instead")
                    continue
                with conn.transaction():
                    conn.execute("SET LOCAL lock_timeout = '10s'")
                    conn.execute(sql)
                    conn.execute("INSERT INTO public.billing_setup_history (version, name, checksum) VALUES (%s, %s, %s)", (version, name, checksum(sql)))
                applied.append(name)
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (SETUP_LOCK,))
            conn.commit()
    return applied


def open_pool(database_url: str) -> ConnectionPool:
    return ConnectionPool(database_url, min_size=1, max_size=10, open=True, kwargs={"autocommit": False})
