"""Times an import from file to "ready": the survey, then the load and tidy and the matching, with seconds per step and the worker's
peak memory. Prints headings, counts and timings only, never a row.

    CRM_TEST_ADMIN_URL=postgres://postgres@localhost:5432/scratch python tools/bench.py 1000000          # a made-up list of N rows
    CRM_TEST_ADMIN_URL=postgres://postgres@localhost:5432/scratch python tools/bench.py path/to/list.csv # a real list

The database must be a disposable one: its crm and importing schemas are dropped and rebuilt from crm-core's migrations, and dropped
again at the end. Needs psutil. Run one at a time: a run that is killed leaves its statement running in PostgreSQL, and the next run
then measures the leftover."""
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil
import psycopg

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import worker  # noqa: E402

ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"


def made_up(rows: int, folder: Path) -> Path:
    """A list of `rows` people, 8% of them a repeat of an earlier row, with a quarter as many leads already in the account."""
    random.seed(1)
    path = folder / "made-up.csv"
    with open(path, "w", encoding="utf-8", newline="") as out:
        out.write("Name,Phone,Email,Address,Zip\n")
        for i in range(rows):
            k = i if random.random() > 0.08 else random.randrange(max(i, 1))
            out.write(f"Person {k},{2125550000 + k % 9000 + (k // 9000) * 10000},p{k}@x.com,{k} Main St,{70000 + k % 900}\n")
    return path


def main() -> None:
    argument = sys.argv[1]
    folder = Path(tempfile.mkdtemp())
    worker.IMPORT_DIR = folder
    source = made_up(int(argument), folder) if argument.isdecimal() else Path(argument)
    admin = psycopg.connect(os.environ["CRM_TEST_ADMIN_URL"])
    with admin.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS crm CASCADE; DROP SCHEMA IF EXISTS importing CASCADE; CREATE SCHEMA crm; SET search_path = crm, public")
        for script in sorted((HERE.parent.parent / "crm-core" / "migrations").glob("*.sql")):
            cur.execute(script.read_text(encoding="utf8"))
        cur.execute("INSERT INTO crm.orgs (id, name) VALUES (%s, 'Bench')", (ORG,))
        if argument.isdecimal():
            cur.execute("""INSERT INTO crm.leads (org_id, name, phone) SELECT %s, 'Existing ' || g, (3125550000 + g)::text
                           FROM generate_series(1, %s) g""", (ORG, int(argument) // 4))
    admin.commit()
    admin.execute("SET search_path = importing, public")
    size = source.stat().st_size
    with admin.cursor() as cur:
        cur.execute("""INSERT INTO importing.jobs (org_id, user_id, name, filename, size, chunk_size, total_chunks, status)
                       VALUES (%s, '11111111-1111-4111-8111-111111111111', 'Bench', %s, %s, %s, 1, 'queued') RETURNING id::text""",
                    (ORG, "list" + source.suffix.lower(), size, size))
        job_id = cur.fetchone()[0]
        (folder / job_id).mkdir()
        shutil.copyfile(source, folder / job_id / "0.part")
        cur.execute("INSERT INTO importing.chunks (job_id, n, size, sha256) VALUES (%s, 0, %s, 'x')", (job_id, size))
    admin.commit()

    peak = [0]

    def watch() -> None:
        process = psutil.Process()
        while True:
            peak[0] = max(peak[0], process.memory_info().rss)
            time.sleep(0.2)

    threading.Thread(target=watch, daemon=True).start()
    started = time.monotonic()
    worker.load(admin, worker.claim(admin))
    survey = time.monotonic() - started
    status, error, columns, report = admin.execute("SELECT status, error, columns, report FROM importing.jobs WHERE id = %s", (job_id,)).fetchone()
    print(f"survey {survey:.1f} s | {status} {error} | rows {report.get('rows')} | columns offered {len(columns)} "
          f"| empty {len(report.get('empty_columns_removed', []))} | relatives left out {report.get('relatives_left_out')}", flush=True)
    for column in columns:  # what the screen sends when the person accepts every suggestion
        column["field"], column["used"] = column["suggested"], column["suggested"] is not None
    admin.execute("UPDATE importing.jobs SET columns = %s::jsonb, status = 'cleaning', heartbeat_at = NULL WHERE id = %s", (json.dumps(columns), job_id))
    admin.commit()
    started = time.monotonic()
    worker.clean(admin, worker.claim(admin))
    clean = time.monotonic() - started
    status, error, report = admin.execute("SELECT status, error, report FROM importing.jobs WHERE id = %s", (job_id,)).fetchone()
    for key in ("exact_examples", "empty_columns_removed", "dropped_columns"):
        report.pop(key, None)
    states = admin.execute("SELECT jsonb_object_agg(state, n) FROM (SELECT state, count(*) AS n FROM importing.rows WHERE job_id = %s GROUP BY 1) x", (job_id,)).fetchone()[0]
    print(f"load, tidy and match {clean:.1f} s | total {survey + clean:.1f} s | peak memory {peak[0] >> 20} MB | {status} {error}")
    print("report:", report)
    print("rows by state:", states)
    admin.execute("DROP SCHEMA IF EXISTS crm CASCADE")
    admin.execute("DROP SCHEMA IF EXISTS importing CASCADE")
    admin.commit()
    shutil.rmtree(folder, ignore_errors=True)


if __name__ == "__main__":
    main()
