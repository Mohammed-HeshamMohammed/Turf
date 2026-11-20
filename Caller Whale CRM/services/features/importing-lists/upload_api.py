"""The import worker owns upload admission, pieces, and temporary storage."""
import errno
import hashlib
import json
import os
import re
import shutil
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg
from psycopg.rows import dict_row

CHUNK_SIZE = int(os.environ.get("IMPORT_CHUNK_KB", "1024")) << 10  # 1 MiB pieces: a dropped connection loses little, and progress moves smoothly
MAX_ACTIVE = 3
# A list needs room for the pieces, the joined file and (for text) its UTF-8 copy: this many times its size must be free, plus a reserve.
SPACE_FACTOR = 3
RESERVE = 1 << 30


def import_dir() -> Path:
    return Path(os.environ.get("IMPORT_DIR", "/data/imports"))


def check_space(size: int) -> None:
    """Refuses a list the disk could not hold. A full disk would stop every workspace's imports (and the database, if they share it)."""
    folder = import_dir()
    folder.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(folder).free < size * SPACE_FACTOR + RESERVE:
        raise APIError(507, "The server is short of space for a list this big right now. Try again later or split the list.", "no_space")
ID = re.compile(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$", re.I)
SHA = re.compile(r"^[0-9a-f]{64}$", re.I)
EXTENSIONS = {".csv", ".txt", ".xlsx", ".xls"}
JOB_COLUMNS = "id::text, name, filename, size, chunk_size, total_chunks, status, progress, columns, report, error, loaded_rows, merged_rows, project_id::text, created_at, updated_at, kind, source_timezone, for_skip_tracing"


class APIError(Exception):
    def __init__(self, status: int, message: str, code: str = "bad_request"):
        super().__init__(message)
        self.status, self.code = status, code


def database():
    return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)


def core_request(handler, method: str, path: str, body: dict | None = None):
    headers = {"Authorization": handler.headers.get("Authorization", ""),
               "x-callerwhale-org": handler.headers.get("x-callerwhale-org", "")}
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(os.environ.get("CORE_URL", "http://crm-core:8107").rstrip("/") + path,
                                     data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=12) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get("error", {})
            if isinstance(detail, dict):
                raise APIError(error.code, detail.get("message", "The CRM refused this request."), detail.get("code", "forbidden"))
        except (ValueError, AttributeError):
            pass
        raise APIError(error.code, "The CRM refused this request.")
    except urllib.error.URLError:
        raise APIError(503, "The CRM is not answering. Try again shortly.", "core_unavailable")


def principal(handler):
    if not handler.headers.get("Authorization", "").lower().startswith("bearer "):
        raise APIError(401, "Sign in again.", "unauthorized")
    org = handler.headers.get("x-callerwhale-org", "")
    if not ID.fullmatch(org):
        raise APIError(400, "Choose a workspace (x-callerwhale-org).")
    me = core_request(handler, "GET", "/api/v1/me")
    if me.get("organization_id") != org:
        raise APIError(403, "Choose a workspace you can access.", "forbidden")
    if "import" not in me.get("capabilities", []):
        raise APIError(403, "Your role cannot import lists.", "forbidden")
    return me


def serialize(job):
    return {key: value.isoformat() if hasattr(value, "isoformat") else value for key, value in job.items()}


def get_job(conn, me, job_id):
    if not ID.fullmatch(job_id):
        raise APIError(404, "That import does not exist.", "not_found")
    row = conn.execute(f"SELECT {JOB_COLUMNS} FROM importing.jobs WHERE id = %s AND org_id = %s AND (user_id = %s OR %s)",
                       (job_id, me["organization_id"], me["user"]["id"], "admin" in me.get("capabilities", []))).fetchone()
    if row is None:
        raise APIError(404, "That import does not exist.", "not_found")
    return serialize(row)


def reply(conn, me, job_id):
    job = get_job(conn, me, job_id)
    if job["status"] == "uploading":
        folder = Path(os.environ.get("IMPORT_DIR", "/data/imports")) / job_id
        # A database record alone is not proof the worker still has the piece.
        job["received"] = [r["n"] for r in conn.execute("SELECT n, size FROM importing.chunks WHERE job_id = %s ORDER BY n", (job_id,))
                           if (folder / f'{r["n"]}.part').is_file() and (folder / f'{r["n"]}.part').stat().st_size == r["size"]]
    if job["status"] == "queued":
        job["queue"] = queue_info(conn, me, job)
    return job


def queue_info(conn, me, job):
    """What a waiting import is waiting for: how many lists are ahead, and the one being worked on (its name and progress when it is the
    same workspace's, so a stuck one can be seen and cancelled; only that something is running when it is another workspace's)."""
    rows = conn.execute("""SELECT id::text, org_id::text, name, status, progress, loaded_rows,
                                  extract(epoch FROM now() - coalesce(heartbeat_at, updated_at))::int AS idle
                           FROM importing.jobs
                           WHERE id::text <> %s AND NOT cancel_requested
                             AND (status IN ('loading', 'cleaning') OR (status = 'queued' AND created_at < (SELECT created_at FROM importing.jobs WHERE id::text = %s)))
                           ORDER BY (status IN ('loading', 'cleaning')) DESC, created_at""", (job["id"], job["id"])).fetchall()
    running = next((r for r in rows if r["status"] in ("loading", "cleaning")), None)
    info = {"ahead": len(rows), "running": None}
    if running:
        mine = running["org_id"] == me["organization_id"]
        progress = running["progress"] or {}
        info["running"] = ({"id": running["id"], "name": running["name"], "status": running["status"], "phase": progress.get("phase"), "step": progress.get("step"),
                            "done": progress.get("done"), "total": progress.get("total") or running["loaded_rows"], "idle_seconds": running["idle"]}
                           if mine else {"other_workspace": True, "idle_seconds": running["idle"]})
    return info


def start(handler, me):
    # Real leads wait for the carriers to verify the agency (build step 39, D314); the CRM says so in /api/v1/me.
    if (me.get("carrier") or {}).get("may_import") is False:
        raise APIError(403, "Importing opens once the carriers verify the agency's business. The owner submits it under Settings, Carrier registration.", "carrier_check")
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        raise APIError(400, "Invalid request length.")
    if length < 1 or length > 65536:
        raise APIError(400, "Invalid request length.")
    try:
        body = json.loads(handler.rfile.read(length))
    except (ValueError, UnicodeDecodeError):
        raise APIError(400, "Send a valid list description.")
    if not isinstance(body, dict):
        raise APIError(400, "Send a valid list description.")
    filename = str(body.get("filename", "")).replace("\\", "/").rsplit("/", 1)[-1].strip()
    extension = Path(filename).suffix.lower()
    if extension not in EXTENSIONS:
        raise APIError(400, "Lists can be CSV, TXT, XLSX or XLS files.")
    size = body.get("size")
    maximum = int(os.environ.get("MAX_IMPORT_MB", "20480"))
    if type(size) is not int or size < 1 or size > maximum << 20:
        raise APIError(400, f"That file is empty or larger than {maximum} MB.")
    name = str(body.get("name") or Path(filename).stem).strip()
    if not name or len(name) > 200:
        raise APIError(400, "Name the list in 200 characters or fewer.")
    header = body.get("has_header", True)
    if type(header) is not bool:
        raise APIError(400, "Choose whether the list has a header row.")
    skip_tracing = body.get("skip_tracing", False)
    if type(skip_tracing) is not bool:
        raise APIError(400, "Say whether this list is for skip tracing.")
    kind = body.get("kind", "lead_list")
    if not isinstance(kind, str) or kind not in {"lead_list", "readymode_calls"}:
        raise APIError(400, "Choose a supported import type.")
    timezone = body.get("source_timezone", "UTC")
    if not isinstance(timezone, str) or len(timezone) > 64:
        raise APIError(400, "Choose the time zone used in the export.")
    try:
        ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise APIError(400, "Choose a valid time zone for the export.")
    if kind == "readymode_calls" and (extension != ".csv" or not header or body.get("project_id")):
        raise APIError(400, "ReadyMode call history needs a CSV with headings and no source list.")
    with database() as conn:
        active = conn.execute("SELECT count(*) AS n FROM importing.jobs WHERE org_id = %s AND status NOT IN ('done', 'failed', 'cancelled')",
                              (me["organization_id"],)).fetchone()["n"]
        if active >= MAX_ACTIVE:
            raise APIError(429, "You already have 3 imports in progress. Finish or cancel one before starting another.", "too_many_imports")
        in_flight = conn.execute("SELECT coalesce(sum(size), 0) AS n FROM importing.jobs WHERE org_id = %s AND status NOT IN ('done', 'failed', 'cancelled')",
                                 (me["organization_id"],)).fetchone()["n"]
        if in_flight + size > int(os.environ.get("MAX_ORG_ACTIVE_MB", "30720")) << 20:
            raise APIError(429, "Your imports in progress are already very large. Wait for one to finish, then send this list.", "too_much_in_progress")
        check_space(size)
        project = body.get("project_id")
        if project:
            if not isinstance(project, str) or not ID.fullmatch(project):
                raise APIError(400, "That list does not exist.")
            projects = core_request(handler, "GET", "/api/v1/projects")
            if not any(p.get("id") == project for p in projects):
                raise APIError(400, "That list does not exist.")
        elif kind == "lead_list":
            project = core_request(handler, "POST", "/api/v1/projects", {"name": name})["id"]
        # The list belongs to the team chosen at import (D110): one the person is in or leads; the owner and admins (who see the whole
        # workspace) may choose any team. Without a choice it is the person's first team, as before. The leads start unassigned there.
        team_ids = [t for t in (me.get("team_ids") or []) if isinstance(t, str) and ID.fullmatch(t)]
        chosen = body.get("team_id")
        if chosen is not None and chosen != "":
            if not isinstance(chosen, str) or not ID.fullmatch(chosen):
                raise APIError(400, "Choose one of your teams.")
            if chosen not in team_ids:
                if "organization" not in (me.get("scopes") or []):
                    raise APIError(403, "You can import into a team you are in or lead.")
                teams = core_request(handler, "GET", "/api/v1/admin/teams")
                if not any(isinstance(t, dict) and t.get("id") == chosen for t in teams or []):
                    raise APIError(400, "That team is not in this workspace.")
            team = chosen
        else:
            team = team_ids[0] if team_ids else None
        row = conn.execute("""INSERT INTO importing.jobs (org_id, user_id, project_id, team_id, name, filename, size, chunk_size, total_chunks, has_header, kind, source_timezone, for_skip_tracing, progress)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, '{"phase":"uploading","done":0}') RETURNING id::text""",
            (me["organization_id"], me["user"]["id"], project, team, name, filename, size, CHUNK_SIZE,
             (size + CHUNK_SIZE - 1) // CHUNK_SIZE, header, kind, timezone, skip_tracing and kind == "lead_list")).fetchone()
        job_id = row["id"]
        (Path(os.environ.get("IMPORT_DIR", "/data/imports")) / job_id).mkdir(parents=True, exist_ok=True)
        return reply(conn, me, job_id)


def chunk(handler, me, job_id, number):
    # The job is looked up and the connection let go before the piece is read: a slow sender must not hold a database connection.
    with database() as conn:
        job = get_job(conn, me, job_id)
    if job["status"] != "uploading":
        raise APIError(400, "This import is no longer receiving pieces.")
    if not number.isdecimal() or int(number) >= job["total_chunks"]:
        raise APIError(400, "That piece number is not part of this file.")
    n = int(number)
    want = min(CHUNK_SIZE, job["size"] - n * CHUNK_SIZE)
    sha = handler.headers.get("x-chunk-sha256", "").lower()
    if not SHA.fullmatch(sha):
        raise APIError(400, "Send the piece's SHA-256 in x-chunk-sha256.")
    if handler.headers.get("Content-Length") != str(want):
        raise APIError(400, "That piece has the wrong size; send it again.")
    folder = import_dir() / job_id
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    temp = None
    try:
        with tempfile.NamedTemporaryFile(prefix="incoming-", dir=folder, delete=False) as out:
            temp = Path(out.name)
            remaining = want
            while remaining:
                data = handler.rfile.read(min(1 << 20, remaining))
                if not data:
                    raise APIError(400, "The piece did not arrive whole; send it again.")
                out.write(data)
                digest.update(data)
                remaining -= len(data)
            out.flush()
            os.fsync(out.fileno())
        if digest.hexdigest() != sha:
            raise APIError(422, "The piece was damaged on the way; send it again.", "fingerprint_mismatch")
        os.replace(temp, folder / f"{n}.part")
        with database() as conn:
            conn.execute("""INSERT INTO importing.chunks (job_id, n, size, sha256) VALUES (%s, %s, %s, %s)
                ON CONFLICT (job_id, n) DO UPDATE SET size = EXCLUDED.size, sha256 = EXCLUDED.sha256""", (job_id, n, want, sha))
            conn.execute("UPDATE importing.jobs SET updated_at = now() WHERE id = %s", (job_id,))
        return {"n": n, "stored": True}
    except OSError as error:
        if error.errno == errno.ENOSPC:
            raise APIError(507, "The server ran out of space for this list. Try again later.", "no_space")
        raise
    finally:
        if temp is not None:
            temp.unlink(missing_ok=True)


def complete(me, job_id):
    with database() as conn:
        job = get_job(conn, me, job_id)
        if job["status"] != "uploading":
            return job
        folder = Path(os.environ.get("IMPORT_DIR", "/data/imports")) / job_id
        pieces = conn.execute("SELECT n, size FROM importing.chunks WHERE job_id = %s ORDER BY n", (job_id,)).fetchall()
        if len(pieces) != job["total_chunks"] or sum(p["size"] for p in pieces) != job["size"] or any(
                p["n"] != i or not (folder / f"{i}.part").is_file() or (folder / f"{i}.part").stat().st_size != p["size"]
                for i, p in enumerate(pieces)):
            raise APIError(400, "Some pieces are missing from the import worker; send them first.")
        conn.execute("UPDATE importing.jobs SET status = 'queued', progress = '{\"phase\":\"queued\",\"done\":0}', updated_at = now() WHERE id = %s AND status = 'uploading'", (job_id,))
        return reply(conn, me, job_id)
