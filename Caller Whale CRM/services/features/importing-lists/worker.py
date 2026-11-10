"""The import worker. It takes one queued upload at a time, loads it into the holding tables in the CRM database (rows as text, exactly as
they came), drops identical rows within the upload, tells the person which column is which, and after they confirm, cleans phones,
emails and addresses. Rows identical to a prior completed import are linked automatically; changed rows can still need a decision.
Merging into leads is crm-core's job, not this program's: the
database login this runs under can write only the holding tables and read only the few lead fields repeats are matched on.

Heavy steps run inside polars (parsing, building rows) or PostgreSQL (fingerprints, cleaning, joins); Python only moves batches.
Every batch is committed together with the count of rows consumed, so a restart carries on from the last batch."""
import json
import os
import re
import socket
import shutil
import time
import traceback
from pathlib import Path

import polars as pl
import psycopg

import matching
import readers
import readymode
from zoneinfo import ZoneInfo

IMPORT_DIR = Path(os.environ.get("IMPORT_DIR", "/data/imports"))
WORKER = f"{socket.gethostname()}-{os.getpid()}"
STALE = "interval '2 minutes'"
POLL_SECONDS = 2.0
# A job whose worker stopped is picked up again this many times; the next stop fails it (a file that keeps stopping the worker).
MAX_RECLAIMS = 2
CLEAN_RANGE = 100_000


def log(level: str, message: str, **fields) -> None:
    print(json.dumps({"level": level, "message": message, **fields}), flush=True)


class Cancelled(Exception):
    """The person cancelled the import; whatever was loaded is thrown away."""


# ------------------------------------------------------------------------------------------------------------- queue

def claim(conn: psycopg.Connection) -> dict | None:
    """The next job to work on, or None. Only one import loads or cleans at a time, so a second waits in the queue; a job whose worker
    stopped (no heartbeat for two minutes) is picked up again where it left off."""
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(f"""
            UPDATE importing.jobs SET status = 'failed', worker = NULL, heartbeat_at = NULL, updated_at = now(),
                   error = 'The import service stopped several times while reading this list. Try a smaller file, or contact support with the import ID.'
            WHERE status IN ('loading', 'cleaning') AND heartbeat_at IS NOT NULL AND heartbeat_at < now() - {STALE} AND attempts >= {MAX_RECLAIMS}""")
        cur.execute(f"""
            UPDATE importing.jobs SET worker = %s, heartbeat_at = now(),
                   attempts = CASE WHEN status IN ('loading', 'cleaning') AND heartbeat_at IS NOT NULL THEN attempts + 1 ELSE attempts END,
                   status = CASE WHEN status = 'queued' THEN 'loading' ELSE status END, updated_at = now()
            WHERE id = (
                SELECT id FROM importing.jobs
                WHERE NOT cancel_requested
                  AND (status = 'queued' OR (status IN ('loading', 'cleaning') AND (heartbeat_at IS NULL OR heartbeat_at < now() - {STALE})))
                  AND NOT EXISTS (SELECT 1 FROM importing.jobs busy WHERE busy.status IN ('loading', 'cleaning') AND busy.heartbeat_at >= now() - {STALE})
                ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
            RETURNING id::text, org_id::text, user_id::text, filename, size, total_chunks, has_header, status, loaded_rows, report, columns, kind, source_timezone""", (WORKER,))
        job = cur.fetchone()
    conn.commit()
    return job


def beat(cur: psycopg.Cursor, job_id: str, phase: str, done: int, **extra) -> None:
    progress = json.dumps({"phase": phase, "done": done, **extra})
    cur.execute("UPDATE importing.jobs SET heartbeat_at = now(), updated_at = now(), progress = %s::jsonb WHERE id = %s", (progress, job_id))


def check_cancel(conn: psycopg.Connection, job_id: str) -> None:
    with conn.cursor() as cur:
        cur.execute("SELECT cancel_requested OR status = 'cancelled' FROM importing.jobs WHERE id = %s", (job_id,))
        row = cur.fetchone()
    conn.commit()
    if row is None or row[0]:
        raise Cancelled()


# -------------------------------------------------------------------------------------------------------------- load

def array_literals(frame: pl.DataFrame) -> pl.Series:
    """Each row as a PostgreSQL text[] literal, built inside polars: {"a","b"}."""
    quoted = [
        pl.lit('"') + pl.col(c).str.replace_all("\x00", "", literal=True).str.replace_all("\\", "\\\\", literal=True).str.replace_all('"', '\\"', literal=True) + pl.lit('"')
        for c in frame.columns
    ]
    return frame.select((pl.lit("{") + pl.concat_str(quoted, separator=",") + pl.lit("}")).alias("cells")).to_series()


def stage_and_insert(cur: psycopg.Cursor, job_id: str, frame: pl.DataFrame, first_row_no: int) -> tuple[int, int]:
    """Puts one batch in the holding table. Row numbers follow the file, blank lines included, so a row can be found again in the
    original; blank lines are left out and identical rows (same fingerprint) are dropped. Returns (rows kept, rows that were not blank)."""
    numbered = frame.with_row_index("n").filter(~pl.all_horizontal(pl.exclude("n").str.strip_chars() == ""))
    cur.execute("CREATE TEMP TABLE IF NOT EXISTS _stage (row_no bigint, cells text[], fp bytea)")
    cur.execute("TRUNCATE _stage")
    staged = pl.DataFrame({"row_no": numbered["n"].cast(pl.Int64) + first_row_no, "cells": array_literals(numbered.drop("n"))})
    with cur.copy("COPY _stage (row_no, cells) FROM STDIN (FORMAT csv)") as copy:
        copy.write(staged.write_csv(include_header=False))
    cur.execute("UPDATE _stage SET fp = sha256(convert_to(array_to_string(cells, chr(31)), 'UTF8'))")
    cur.execute("INSERT INTO importing.rows (job_id, row_no, fp, cells) SELECT %s, row_no, fp, cells FROM _stage ON CONFLICT DO NOTHING", (job_id,))
    return cur.rowcount, numbered.height


def duplicate_examples(cur: psycopg.Cursor, job_id: str, limit: int) -> list[dict]:
    """Rows of the batch just staged that were dropped, with the row that stayed in their place."""
    cur.execute("""SELECT s.row_no, o.row_no FROM _stage s JOIN importing.rows o ON o.job_id = %s AND o.fp = s.fp
                   WHERE o.row_no <> s.row_no ORDER BY s.row_no LIMIT %s""", (job_id, limit))
    return [{"row": a, "same_as": b} for a, b in cur.fetchall()]


def load(conn: psycopg.Connection, job: dict) -> None:
    job_id = job["id"]
    folder = IMPORT_DIR / job_id
    with conn.cursor() as cur:
        cur.execute("SELECT size FROM importing.chunks WHERE job_id = %s ORDER BY n", (job_id,))
        sizes = [r[0] for r in cur.fetchall()]
    conn.commit()
    if len(sizes) != job["total_chunks"]:
        raise RuntimeError("the upload is incomplete")
    extension = Path(job["filename"]).suffix.lower()
    with conn.cursor() as cur:
        beat(cur, job_id, "assembling", 0)
    conn.commit()
    source = readers.prepare(folder, sizes, extension)

    report = dict(job["report"] or {})
    consumed = job["loaded_rows"]
    dropped = report.get("exact_duplicates", 0)
    empty = report.get("empty_rows", 0)
    examples: list[dict] = report.get("exact_examples", [])
    headers: list[str] = []
    for headers, frame in readers.read_batches(source, job["has_header"], skip_rows=consumed):
        check_cancel(conn, job_id)
        with conn.cursor() as cur:
            kept, nonblank = stage_and_insert(cur, job_id, frame, consumed + 1)
            empty += frame.height - nonblank
            dropped += nonblank - kept
            if len(examples) < 10 and kept < nonblank:
                examples += duplicate_examples(cur, job_id, 10 - len(examples))
            consumed += frame.height
            report.update(exact_duplicates=dropped, empty_rows=empty, exact_examples=examples[:10])
            cur.execute("UPDATE importing.jobs SET loaded_rows = %s, report = %s::jsonb WHERE id = %s", (consumed, json.dumps(report), job_id))
            beat(cur, job_id, "loading", consumed)
        conn.commit()

    headers = headers or readers.headers_of(source, job["has_header"])  # a restart after the last batch has none from the loop
    if not headers:
        raise readers.UnreadableFile("the file has no data rows")
    with conn.cursor() as cur:
        headers, populated, empty_columns = drop_empty_columns(cur, job_id, headers)
        columns = describe_columns(cur, job_id, headers, populated)
        report["empty_columns_removed"] = empty_columns
        report.update(rows=consumed - dropped - empty, source_rows=consumed)
        cur.execute("""UPDATE importing.jobs SET status = 'mapping', columns = %s::jsonb, report = %s::jsonb, worker = NULL, heartbeat_at = NULL,
                       progress = %s::jsonb, updated_at = now() WHERE id = %s AND status = 'loading'""",
                    (json.dumps(columns), json.dumps(report), json.dumps({"phase": "mapping", "done": consumed}), job_id))
    conn.commit()
    for leftover in (*folder.glob("source*"), *folder.glob("*.part")):
        leftover.unlink(missing_ok=True)
    log("INFO", "loaded", job=job_id, rows=consumed, duplicates=dropped)


def load_calls(conn: psycopg.Connection, job: dict) -> None:
    """Stage historical calls as source rows. CRM Core links them to leads only after confirmation."""
    job_id = job["id"]
    folder = IMPORT_DIR / job_id
    with conn.cursor() as cur:
        cur.execute("SELECT size FROM importing.chunks WHERE job_id = %s ORDER BY n", (job_id,))
        sizes = [r[0] for r in cur.fetchall()]
    conn.commit()
    if len(sizes) != job["total_chunks"]:
        raise RuntimeError("the upload is incomplete")
    source = readers.prepare(folder, sizes, ".csv")
    zone = ZoneInfo(job["source_timezone"])
    consumed = job["loaded_rows"]
    report = dict(job["report"] or {})
    accepted, skipped = report.get("valid_calls", 0), report.get("unusable_calls", 0)
    outcomes = dict(report.get("outcomes") or {})
    headers = []
    for headers, frame in readers.read_batches(source, True, skip_rows=consumed):
        check_cancel(conn, job_id)
        positions = readymode.columns(headers)
        entries = []
        for index, cells in enumerate(frame.iter_rows()):
            event = readymode.event(list(cells), positions, zone)
            entries.append((consumed + index + 1, event))
            if event:
                accepted += 1
                outcomes[event["outcome"]] = outcomes.get(event["outcome"], 0) + 1
            else:
                skipped += 1
        with conn.cursor() as cur:
            stage_and_insert(cur, job_id, frame, consumed + 1)
            cur.execute("CREATE TEMP TABLE IF NOT EXISTS _call_data (row_no bigint, data jsonb)")
            cur.execute("TRUNCATE _call_data")
            with cur.copy("COPY _call_data (row_no, data) FROM STDIN") as copy:
                for row_no, event in entries:
                    copy.write_row((row_no, json.dumps(event) if event else None))
            cur.execute("""UPDATE importing.rows r SET call_data = d.data,
                        state = CASE WHEN d.data IS NULL THEN 'skip' ELSE 'loaded' END
                        FROM _call_data d WHERE r.job_id = %s AND r.row_no = d.row_no""", (job_id,))
            consumed += frame.height
            report.update(source_rows=consumed, valid_calls=accepted, unusable_calls=skipped, outcomes=outcomes)
            cur.execute("UPDATE importing.jobs SET loaded_rows = %s, report = %s::jsonb WHERE id = %s", (consumed, json.dumps(report), job_id))
            beat(cur, job_id, "loading", consumed)
        conn.commit()
    headers = headers or readers.headers_of(source, True)
    readymode.columns(headers)
    if accepted == 0:
        raise readers.UnreadableFile("the export has no usable calls")
    with conn.cursor() as cur:
        populated = column_population(cur, job_id, headers)
        kept = [i for i, header in enumerate(headers) if populated[i] and
                (not readymode.key(header).startswith("ph ") or cur.execute(
                    f"SELECT count(*) FROM importing.rows WHERE job_id = %s AND btrim(cells[{i + 1}]) NOT IN ('', '0')",
                    (job_id,)).fetchone()[0])]
        if len(kept) != len(headers):
            cur.execute(f"UPDATE importing.rows SET cells = ARRAY[{', '.join(f'cells[{i + 1}]' for i in kept)}] WHERE job_id = %s", (job_id,))
        report["empty_columns_removed"] = [header for i, header in enumerate(headers) if i not in kept]
        cur.execute("""UPDATE importing.jobs SET status = 'call_ready', columns = %s::jsonb, report = %s::jsonb,
                       worker = NULL, heartbeat_at = NULL, progress = %s::jsonb, updated_at = now()
                       WHERE id = %s AND status = 'loading'""", (json.dumps([{"header": headers[i], "idx": n} for n, i in enumerate(kept)]),
                            json.dumps(report), json.dumps({"phase": "call_ready", "done": accepted}), job_id))
    conn.commit()
    for leftover in (*folder.glob("source*"), *folder.glob("*.part")):
        leftover.unlink(missing_ok=True)
    log("INFO", "call history staged", job=job_id, calls=accepted, unusable=skipped)


def column_population(cur: psycopg.Cursor, job_id: str, headers: list[str]) -> list[int]:
    counts = ", ".join(f"count(*) FILTER (WHERE btrim(cells[{i + 1}]) <> '')" for i in range(len(headers)))
    cur.execute(f"SELECT {counts} FROM importing.rows WHERE job_id = %s", (job_id,))
    return list(cur.fetchone() or [0] * len(headers))


def drop_empty_columns(cur: psycopg.Cursor, job_id: str, headers: list[str]) -> tuple[list[str], list[int], list[str]]:
    """Remove columns with no nonblank cell from every stored source row and reindex the remaining headers."""
    populated = column_population(cur, job_id, headers)
    kept = [i for i, count in enumerate(populated) if count > 0]
    if not kept:
        raise readers.UnreadableFile("the file has no populated columns")
    if len(kept) != len(headers):
        cells = ", ".join(f"cells[{i + 1}]" for i in kept)
        cur.execute(f"UPDATE importing.rows SET cells = ARRAY[{cells}] WHERE job_id = %s", (job_id,))
    return [headers[i] for i in kept], [populated[i] for i in kept], [headers[i] for i, count in enumerate(populated) if count == 0]


def describe_columns(cur: psycopg.Cursor, job_id: str, headers: list[str], populated: list[int] | None = None) -> list[dict]:
    """What the person is shown to confirm: each column's header, how many rows have something in it, a few examples, and the
    lead or structured source field it looks like."""
    if populated is None:
        populated = column_population(cur, job_id, headers)
    cur.execute("SELECT cells FROM importing.rows WHERE job_id = %s ORDER BY row_no LIMIT 300", (job_id,))
    sample_rows = [r[0] for r in cur.fetchall()]
    suggestions = matching.suggest_all(headers)
    standard_keys = matching.standard_keys(headers)
    out = []
    for i, header in enumerate(headers):
        seen: list[str] = []
        for cells in sample_rows:
            value = (cells[i] if i < len(cells) else "").strip()
            if value and value not in seen:
                seen.append(value[:80])
            if len(seen) == 3:
                break
        detail = matching.source_detail(header)
        out.append({"idx": i, "header": header, "suggested": suggestions[i] or (standard_keys[i] if detail else None), "source_detail": detail,
                    "standard_key": standard_keys[i],
                    "field": None, "used": None, "populated": populated[i], "samples": seen})
    return out


# ------------------------------------------------------------------------------------------------------------ clean

EMAIL_OK = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


def cleaning_sql(columns: list[dict]) -> str:
    """The expressions that turn a row's cells into the CRM's fields, from the columns the person kept."""
    by_field: dict[str, list[int]] = {}
    for col in columns:
        if col.get("used") and col.get("field"):
            by_field.setdefault(col["field"], []).append(col["idx"] + 1)

    def cell(i: int) -> str:
        return f"nullif(btrim(cells[{i}]), '')"

    def first(field: str, wrap) -> str:
        parts = [wrap(i) for i in by_field.get(field, [])]
        return f"coalesce({', '.join(parts)})" if parts else "NULL::text"

    text = lambda i: f"nullif(regexp_replace(btrim(cells[{i}]), '\\s+', ' ', 'g'), '')"
    email = lambda i: f"CASE WHEN lower(btrim(cells[{i}])) ~ '{EMAIL_OK}' THEN lower(btrim(cells[{i}])) END"
    phone = lambda i: f"importing.norm_phone(cells[{i}])"
    number = lambda low, high: lambda i: f"CASE WHEN btrim(cells[{i}]) ~ '^-?[0-9]+(\\.[0-9]+)?$' AND btrim(cells[{i}])::float8 BETWEEN {low} AND {high} THEN btrim(cells[{i}])::float8 END"
    money = lambda i: (f"CASE WHEN regexp_replace(cells[{i}], '[$, ]', '', 'g') ~ '^[0-9]+(\\.[0-9]+)?$' "
                       f"AND length(regexp_replace(cells[{i}], '[$, .].*', '')) < 12 THEN regexp_replace(cells[{i}], '[$, ]', '', 'g')::numeric END")
    zip5 = lambda i: f"CASE WHEN btrim(cells[{i}]) ~ '^[0-9]{{5}}(-[0-9]{{4}})?$' THEN left(btrim(cells[{i}]), 5) ELSE {cell(i)} END"
    region = lambda i: f"CASE WHEN length(btrim(cells[{i}])) = 2 THEN upper(btrim(cells[{i}])) ELSE {cell(i)} END"

    given = first("first_name", cell)
    family = first("last_name", cell)
    name = f"coalesce({first('name', text)}, nullif(btrim(coalesce({given}, '') || ' ' || coalesce({family}, '')), ''))"
    return ", ".join([
        f"{name} AS name", f"{first('phone', phone)} AS phone", f"{first('email', email)} AS email", f"{first('address', text)} AS address",
        f"{first('unit', text)} AS unit", f"{first('city', text)} AS city", f"{first('region', region)} AS region", f"{first('zip', zip5)} AS zip",
        f"{first('country', text)} AS country", f"{first('latitude', number(-90, 90))}::float8 AS latitude",
        f"{first('longitude', number(-180, 180))}::float8 AS longitude", f"{first('parcel', text)} AS parcel",
        f"{first('value', money)}::numeric AS value", f"{first('source', text)} AS source",
    ])


def source_data_sql(columns: list[dict]) -> str:
    """Original nonempty values under stable keys, including manually identified source fields."""
    lead_fields = {"name", "first_name", "last_name", "phone", "email", "address", "unit", "city", "region", "zip",
                   "country", "latitude", "longitude", "parcel", "value", "source"}
    recognized = []
    used = set()
    for column in columns:
        if not column.get("used"):
            continue  # The original cell remains in cells; it was not confirmed as structured data.
        field = column.get("field")
        base = field if field and field not in lead_fields else column.get("standard_key") or field
        if not base:
            continue
        key = base
        suffix = 2
        while key in used:
            key = f"{base}_{suffix}"
            suffix += 1
        used.add(key)
        recognized.append((key, column["idx"] + 1))
    if not recognized:
        return "'{}'::jsonb"
    keys = ", ".join("'" + key.replace("'", "''") + "'" for key, _ in recognized)
    values = ", ".join(f"nullif(btrim(cells[{index}]), '')" for _, index in recognized)
    return f"jsonb_strip_nulls(jsonb_object(ARRAY[{keys}]::text[], ARRAY[{values}]::text[]))"


def clean(conn: psycopg.Connection, job: dict) -> None:
    job_id = job["id"]
    columns = job["columns"]
    expressions = cleaning_sql(columns)
    source_data = source_data_sql(columns)
    with conn.cursor() as cur:
        cur.execute("SELECT coalesce(min(row_no), 0), coalesce(max(row_no), 0) FROM importing.rows WHERE job_id = %s", (job_id,))
        low, high = cur.fetchone()
    conn.commit()
    done = 0
    total = int(job.get("loaded_rows") or 0)
    started = time.monotonic()
    for start in range(low, high + 1, CLEAN_RANGE):
        check_cancel(conn, job_id)
        with conn.cursor() as cur:
            cur.execute(f"""
                WITH c AS (SELECT row_no, {expressions}, {source_data} AS source_data FROM importing.rows WHERE job_id = %(job)s AND state = 'loaded' AND row_no >= %(a)s AND row_no < %(b)s)
                UPDATE importing.rows r SET name = c.name, phone = c.phone, email = c.email, address = c.address, unit = c.unit, city = c.city,
                       region = c.region, zip = c.zip, country = c.country, latitude = c.latitude, longitude = c.longitude, parcel = c.parcel,
                       value = c.value, source = c.source, source_data = c.source_data,
                       state = CASE WHEN c.name IS NULL AND c.phone IS NULL AND c.email IS NULL AND c.address IS NULL THEN 'skip' ELSE 'clean' END
                FROM c WHERE r.job_id = %(job)s AND r.row_no = c.row_no""", {"job": job_id, "a": start, "b": start + CLEAN_RANGE})
            done += cur.rowcount
            beat(cur, job_id, "cleaning", done, total=total)
        conn.commit()
        log("INFO", "cleaning batch", job=job_id, rows=done, seconds=round(time.monotonic() - started, 1))
    # The two steps after the tidying compare rows with each other and with the leads already in the CRM; each says so, so a slow one
    # is seen in the log and on the screen instead of looking stuck.
    check_cancel(conn, job_id)
    with conn.cursor() as cur:
        beat(cur, job_id, "matching", done, total=total, step="exact repeats of earlier lists")
    conn.commit()
    step = time.monotonic()
    exact_existing = skip_identical_prior_rows(conn, job)
    log("INFO", "exact repeats checked", job=job_id, found=exact_existing, seconds=round(time.monotonic() - step, 1))
    check_cancel(conn, job_id)
    with conn.cursor() as cur:
        beat(cur, job_id, "matching", done, total=total, step="repeats inside the list and against your leads")
    conn.commit()
    step = time.monotonic()
    groups = find_repeats(conn, job)
    log("INFO", "repeats found", job=job_id, groups=groups, seconds=round(time.monotonic() - step, 1))
    dropped = [c["header"] for c in columns if not c.get("used")]
    with conn.cursor() as cur:
        cur.execute("""SELECT count(*) FILTER (WHERE state = 'skip' AND lead_id IS NULL),
                              count(*) FILTER (WHERE state = 'clean' AND phone IS NULL AND email IS NULL),
                              count(*) FILTER (WHERE state IN ('clean', 'import', 'merge'))
                       FROM importing.rows WHERE job_id = %s""", (job_id,))
        no_contact_row = cur.fetchone()
        report = dict(job["report"] or {})
        report.update(unusable_rows=no_contact_row[0], without_phone_or_email=no_contact_row[1], near_groups=groups,
                      exact_existing=exact_existing, dropped_columns=dropped)
        status = "reviewing" if groups else "done" if exact_existing and no_contact_row[0] == 0 and no_contact_row[2] == 0 else "ready"
        cur.execute("""UPDATE importing.jobs SET status = %s, report = %s::jsonb, worker = NULL, heartbeat_at = NULL, progress = %s::jsonb, updated_at = now()
                       WHERE id = %s AND status = 'cleaning'""",
                    (status, json.dumps(report), json.dumps({"phase": status, "done": done}), job_id))
    conn.commit()
    log("INFO", "cleaned", job=job_id, rows=done, repeat_groups=groups)


class Groups:
    """Connected rows that share a contact or address and the same person name."""

    def __init__(self) -> None:
        self.parent: dict = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def name_key(name: str | None) -> str:
    """Ignore only case, spacing and punctuation; distinct people stay distinct."""
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def group_source_candidates(rows: list[tuple]) -> Groups:
    """A shared household, family phone or inbox alone is not a repeated lead."""
    groups = Groups()
    first_with: dict = {}
    for row_no, name, phone, email, address_key in rows:
        person = name_key(name)
        for kind, key in (("p", phone), ("e", email), ("a", address_key if person else None)):
            if key is not None:
                groups.union(("r", row_no), first_with.setdefault((kind, key, person), ("r", row_no)))
    return groups


def skip_identical_prior_rows(conn: psycopg.Connection, job: dict) -> int:
    """Link an unchanged source row to its existing lead without asking for a repeat decision.

    The fingerprint is a SHA-256 of the original cells (equal fingerprints mean equal rows, so the old values may be blanked later); the ordered column headings must also agree.
    Only completed imports with a surviving lead in this organization can supply a match.
    """
    headers = [column["header"] for column in job["columns"]]
    with conn.cursor() as cur:
        cur.execute("SET LOCAL statement_timeout = '30min'")
        cur.execute("""
            WITH identical AS (
                SELECT DISTINCT ON (r.row_no) r.row_no, old.lead_id
                FROM importing.rows r
                JOIN importing.rows old ON old.fp = r.fp
                    AND old.lead_id IS NOT NULL AND old.job_id <> r.job_id
                JOIN importing.jobs previous ON previous.id = old.job_id
                    AND previous.org_id = %s::uuid AND previous.user_id = %s::uuid AND previous.status = 'done'
                WHERE r.job_id = %s AND r.state = 'clean'
                    AND (SELECT array_agg(c->>'header' ORDER BY n)
                         FROM jsonb_array_elements(previous.columns) WITH ORDINALITY AS x(c, n)) = %s::text[]
                ORDER BY r.row_no, previous.created_at DESC, old.row_no
            )
            UPDATE importing.rows r SET state = 'skip', lead_id = i.lead_id, match_lead = i.lead_id
            FROM identical i WHERE r.job_id = %s AND r.row_no = i.row_no
        """, (job["org_id"], job["user_id"], job["id"], headers, job["id"]))
        count = cur.rowcount
    conn.commit()
    return count


def find_repeats(conn: psycopg.Connection, job: dict) -> int:
    """Marks rows that match each other, or a lead already in the CRM, after cleaning. Returns how many groups the person must decide."""
    job_id, org = job["id"], job["org_id"]
    with conn.cursor() as cur:
        cur.execute("SET LOCAL statement_timeout = '30min'")
        cur.execute("""
            SELECT row_no, name, phone, email, importing.addr_key(address, zip) AS ak FROM (
                SELECT *, count(*) OVER (PARTITION BY phone) AS cp, count(*) OVER (PARTITION BY email) AS ce,
                       count(*) OVER (PARTITION BY importing.addr_key(address, zip)) AS ca
                FROM importing.rows WHERE job_id = %s AND state = 'clean') x
            WHERE (phone IS NOT NULL AND cp > 1) OR (email IS NOT NULL AND ce > 1) OR (importing.addr_key(address, zip) IS NOT NULL AND ca > 1)""", (job_id,))
        groups = group_source_candidates(cur.fetchall())
        cur.execute("SET cw.matching = 'on'")
        cur.execute("""
            SELECT r.row_no, min(m.id::text) FROM importing.rows r JOIN importing.lead_match m ON m.org_id = %s::uuid
                AND nullif(regexp_replace(lower(coalesce(r.name, '')), '[^a-z0-9]', '', 'g'), '') =
                    nullif(regexp_replace(lower(coalesce(m.name, '')), '[^a-z0-9]', '', 'g'), '')
                AND ((r.phone IS NOT NULL AND m.phone = r.phone) OR (r.email IS NOT NULL AND m.email = r.email)
                     OR (importing.addr_key(r.address, r.zip) IS NOT NULL AND m.addr_key = importing.addr_key(r.address, r.zip)))
            WHERE r.job_id = %s AND r.state = 'clean' GROUP BY r.row_no""", (org, job_id))
        matches = cur.fetchall()
        for row_no, lead in matches:
            groups.union(("r", row_no), ("l", lead))
        members: dict = {}
        for node in list(groups.parent):
            if node[0] == "r":
                members.setdefault(groups.find(node), []).append(node[1])
        lead_of = {groups.find(("r", row_no)): lead for row_no, lead in matches}
        # A group needs a decision when it holds two rows, or a row and a lead. A row alone with nothing to match is no group.
        decided = {root: rows for root, rows in members.items() if len(rows) > 1 or root in lead_of}
        cur.execute("CREATE TEMP TABLE IF NOT EXISTS _groups (row_no bigint, group_id bigint, match_lead uuid)")
        cur.execute("TRUNCATE _groups")
        numbered = {root: n for n, root in enumerate(sorted(decided, key=str), start=1)}
        with cur.copy("COPY _groups (row_no, group_id, match_lead) FROM STDIN") as copy:
            for root, rows in decided.items():
                for row_no in rows:
                    copy.write_row((row_no, numbered[root], lead_of.get(root)))
        cur.execute("""UPDATE importing.rows r SET state = 'near_duplicate', group_id = g.group_id, match_lead = g.match_lead
                       FROM _groups g WHERE r.job_id = %s AND r.row_no = g.row_no""", (job_id,))
    conn.commit()
    return len(decided)


# ------------------------------------------------------------------------------------------------------------- loop

def forget(conn: psycopg.Connection, job_id: str) -> None:
    """A cancelled import leaves nothing behind."""
    conn.rollback()
    with conn.cursor() as cur:
        cur.execute("DELETE FROM importing.rows WHERE job_id = %s", (job_id,))
    conn.commit()


def process(conn: psycopg.Connection, job: dict) -> None:
    try:
        if job.get("kind") == "readymode_calls":
            load_calls(conn, job)
        elif job["status"] == "cleaning":
            clean(conn, job)
        else:
            load(conn, job)
    except Cancelled:
        forget(conn, job["id"])
        shutil.rmtree(IMPORT_DIR / job["id"], ignore_errors=True)
        log("INFO", "cancelled", job=job["id"])
    except Exception as error:  # the person is told in plain words; the details stay in the log
        conn.rollback()
        log("ERROR", "import failed", job=job["id"], phase=job["status"], error_type=type(error).__name__, error=str(error), trace=traceback.format_exc())
        if isinstance(error, readers.UnsafeFile):
            message = "This spreadsheet expands beyond the safe import limit. Save a smaller file and try again."
        elif isinstance(error, readers.UnreadableFile):
            message = "This list could not be read. Check the file format and make sure it has at least one data row."
        else:
            message = "Your file reached Caller Whale, but the import service could not finish processing it. Try again; if it repeats, contact support with the import ID."
        with conn.cursor() as cur:
            cur.execute("""UPDATE importing.jobs SET status = 'failed', worker = NULL, heartbeat_at = NULL, updated_at = now(),
                           error = %s WHERE id = %s""", (message, job["id"]))
        conn.commit()
        shutil.rmtree(IMPORT_DIR / job["id"], ignore_errors=True)


def sweep_uploads(conn: psycopg.Connection) -> None:
    """Clear abandoned uploads and worker-owned files after cancellation, failure or merge."""
    conn.execute("""UPDATE importing.jobs SET status = 'cancelled', error = 'The upload was not finished in time.', updated_at = now()
                    WHERE status = 'uploading' AND updated_at < now() - interval '48 hours'""")
    conn.commit()
    if not IMPORT_DIR.exists():
        return
    for folder in IMPORT_DIR.iterdir():
        if not folder.is_dir():
            continue
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM importing.jobs WHERE id::text = %s", (folder.name,))
            row = cur.fetchone()
        conn.commit()
        if row is None or row[0] in {"cancelled", "failed", "done", "mapping", "reviewing", "ready", "merging", "call_ready", "call_merging"}:
            shutil.rmtree(folder, ignore_errors=True)


def run_forever(url: str) -> None:
    """Waits for work and does it. The connection is opened again after any database trouble."""
    while True:
        try:
            with psycopg.connect(url) as conn:
                conn.execute("SET search_path = importing, public")
                last_sweep = 0.0
                while True:
                    if time.monotonic() - last_sweep > 60:
                        try:
                            sweep_uploads(conn)
                        except OSError as error:
                            log("WARN", "upload cleanup could not finish", error=str(error))
                        last_sweep = time.monotonic()
                    job = claim(conn)
                    if job is None:
                        time.sleep(POLL_SECONDS)
                    else:
                        process(conn, job)
        except psycopg.Error as error:
            log("WARN", "database unavailable, trying again", error=str(error))
            time.sleep(5)
        except Exception as error:  # anything else must not end the thread: the service would look healthy and never work again
            log("ERROR", "the worker loop failed, trying again", error_type=type(error).__name__, error=str(error), trace=traceback.format_exc())
            time.sleep(5)
