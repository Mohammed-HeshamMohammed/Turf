"""Versioned command API for the desktop host and the dev server, both over JSON lines on stdin/stdout.

Request:  {"schema_version": 1, "command": "dataset.list", "payload": {...}}
Response: {"schema_version": 1, "ok": true, "result": ...} or {"schema_version": 1, "ok": false, "error": {"code", "message"}}
Long-running commands return a job_id immediately; progress is read from durable job events.

This is DataForge's command router cut down to what Turf has: projects, lists and Skip Tracing.
"""

from __future__ import annotations

import base64
import hashlib
import json
import shutil
import threading
from uuid import uuid4
from dataclasses import asdict
from pathlib import Path
from typing import Callable

from . import SCHEMA_VERSION
from . import area, combine, datasets, exports, keeping, leads, sameness, dnc_registry, downloads, emails, flood, geo, images, nanpa_blocks, manual, phone_evidence, phone_lookup, projects, skiptrace, tidy
from .contracts import health_check
from .jobs import JobContext, JobKind, JobRunner, JobValidationError
from .logs import log
from .storage import ProjectStore

SERVICE_ROOT = Path(__file__).resolve().parents[1]

# Rows a single dataset.rows call may return. Larger than DataForge's 500: Turf reads whole lists, and fewer, bigger
# pages are much quicker over the pipe.
MAX_ROWS_PER_CALL = 5000

IMPORT_TYPES = (".csv", ".tsv", ".txt", ".json", ".jsonl", ".ndjson", ".xlsx", ".xml", ".parquet", ".docx", ".zip", ".gz")


class CommandError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _job_dict(row) -> dict:
    job = dict(row)
    job["params"] = json.loads(job.pop("params_json") or "{}")
    job["result"] = json.loads(job.pop("result_json")) if job.get("result_json") else None
    return job


class Service:
    def __init__(self, migrations_dir: Path | None = None) -> None:
        self.migrations_dir = migrations_dir or SERVICE_ROOT / "migrations"
        self.store: ProjectStore | None = None
        self.project: dict | None = None
        self.runner: JobRunner | None = None
        self._lock = threading.RLock()
        self.commands: dict[str, Callable[[dict], object]] = {
            "health.check": lambda p: health_check().to_dict(),
            "project.create": lambda p: self._open(p.get("path", ""), p.get("name"), create=True),
            "project.open": lambda p: self._open(p.get("path", "")),
            "project.current": lambda p: self.project,
            "project.recent": lambda p: projects.recent_projects(),
            "dataset.import": lambda p: {"job_id": self._submit("dataset_import", p)},
            "dataset.import_content": self._import_content,
            "dataset.list": lambda p: datasets.list_datasets(self._store(), self._project_id()),
            "dataset.rows": lambda p: datasets.dataset_rows(self._store(), p["dataset_id"], int(p.get("offset", 0)), min(int(p.get("limit", 50)), MAX_ROWS_PER_CALL)),
            "dataset.rows_compact": lambda p: datasets.dataset_rows_compact(self._store(), p["dataset_id"], int(p.get("offset", 0)), min(int(p.get("limit", 50)), MAX_ROWS_PER_CALL)),
            "dataset.rename": self._dataset_rename,
            "dataset.download": lambda p: downloads.prepare(self._store(), p["dataset_id"], p["version"]),
            "dataset.download_chunk": lambda p: downloads.chunk(self._store(), p["dataset_id"], p["version"], int(p["offset"]), p["hash"]),
            "dataset.download_save": lambda p: downloads.save(self._store(), p["dataset_id"], p["version"], p["path"], p["hash"]),
            "dataset.delete": lambda p: datasets.delete_dataset(self._store(), p["dataset_id"]) or {"deleted": p["dataset_id"]},
            "job.list": lambda p: [_job_dict(r) for r in self._store().list_jobs(self._project_id(), int(p.get("limit", 50)))],
            "job.get": self._job_get,
            "job.cancel": lambda p: self._runner().cancel(self._store(), p["job_id"]) or {"job_id": p["job_id"]},
            "dnc_registry.status": lambda p: dnc_registry.status(),
            "dnc_registry.import": lambda p: {"job_id": self._submit("dnc_registry_import", p)},
            "dnc_registry.remove": lambda p: dnc_registry.remove(p.get("area_code")),
            "nanpa_blocks.status": lambda p: nanpa_blocks.status(),
            "nanpa_blocks.import": lambda p: {"job_id": self._submit("nanpa_blocks_import", p)},
            "flood.of": lambda p: flood.flood_of(p.get("lat"), p.get("lon"), force=bool(p.get("again"))),
            "emails.check": lambda p: emails.check(p.get("addresses")),
            "area.of": lambda p: area.area_of(p.get("lat"), p.get("lon")),
            "area.key_status": lambda p: area.key_status(),
            "area.set_key": lambda p: area.set_key(p.get("key")),
            "images.embedded": lambda p: images.embedded(self._store(), p.get("name")),
            "images.aerial": lambda p: images.aerial(p.get("lat"), p.get("lon")),
            "geo.zip_centres": lambda p: geo.zip_centres(list(p.get("zips") or [])),
            "geo.zip_outlines": lambda p: geo.zip_outlines(list(p.get("zips") or [])),
            "geo.located": lambda p: geo.located(self._store(), p["dataset_id"], dict(p.get("columns") or {})),
            "geo.locate": lambda p: {"job_id": self._submit("geo_locate", p)},
            "skiptrace.suggest": lambda p: skiptrace.suggest(self._store(), p["dataset_id"], str(p.get("region") or "US")),
            "skiptrace.statuses": lambda p: skiptrace.statuses_for(self._store(), p["dataset_id"], p["column"], str(p.get("region") or "US"), p.get("names_mapped") is not False),
            "skiptrace.remember": lambda p: skiptrace.remember_statuses(self._store(), p["dataset_id"], p.get("decisions")),
            "skiptrace.model_status": lambda p: skiptrace.status_model.state(),
            "skiptrace.save_settings": lambda p: skiptrace.save_settings(self._store(), p["dataset_id"], p.get("config")),
            "skiptrace.scan": lambda p: {"job_id": self._submit("skiptrace_scan", p)},
            "skiptrace.apply": lambda p: {"job_id": self._submit("skiptrace_apply", p)},
            "skiptrace.freshness": lambda p: skiptrace.freshness(self._store(), p["dataset_id"]),
            "skiptrace.review": lambda p: skiptrace.review(self._store(), p["job_id"], str(p.get("filter") or "all"), int(p.get("offset", 0)), int(p.get("limit", 25)), p.get("row_number")),
            "dataset.trash": lambda p: keeping.trash(self._store(), self._project_id(), p["dataset_id"]),
            "dataset.trashed": lambda p: keeping.trashed(self._store(), self._project_id()),
            "dataset.restore": lambda p: keeping.restore(self._store(), self._project_id(), p["dataset_id"]),
            "dataset.purge": lambda p: keeping.purge(self._store(), self._project_id(), p.get("dataset_id")),
            "project.backup": lambda p: {"job_id": self._submit("project_backup", p)},
            "filters.list": lambda p: keeping.filters(self._store(), p["dataset_id"]),
            "filters.save": lambda p: keeping.save_filter(self._store(), p["dataset_id"], p.get("name"), p.get("filter")),
            "leads.for_list": lambda p: leads.for_list(self._store(), p["dataset_id"]),
            "leads.get": lambda p: leads.get(self._store(), p),
            "leads.set": lambda p: leads.set_state(self._store(), p),
            "leads.notes": lambda p: leads.notes(self._store(), p),
            "leads.add_note": lambda p: leads.add_note(self._store(), p),
            "leads.remove_note": lambda p: leads.remove_note(self._store(), p),
            "leads.due": lambda p: leads.due(self._store(), self._project_id(), p.get("today")),
            "calling.zones": lambda p: leads.zones(p.get("numbers")),
            "export.prepare": lambda p: exports.prepare(self._store(), p),
            "export.chunk": lambda p: exports.chunk(p),
            "export.save": lambda p: exports.save(self._store(), p),
            "lists.combine": lambda p: {"job_id": self._submit("lists_combine", p)},
            "duplicates.overrule": lambda p: combine.overrule(self._store(), p),
            "duplicates.overrules": lambda p: combine.overrules(self._store(), [str(item) for item in p.get("dataset_ids") or []]),
            "marks.list": lambda p: manual.list_marks(self._store()),
            "marks.set": lambda p: manual.set_mark(self._store(), p["number"], p.get("mark"), p.get("until")),
            "marks.history": lambda p: manual.history(self._store(), p.get("number")),
            "marks.import_legacy": lambda p: manual.import_legacy(self._store(), dict(p.get("marks") or {})),
            "phone.outcomes": lambda p: phone_evidence.list_events(self._store(), p.get("number"), p.get("limit", 100), p.get("offset", 0)),
            "phone.record_outcome": lambda p: phone_evidence.record(self._store(), p),
            "phone.retract_outcome": lambda p: phone_evidence.retract(self._store(), p["id"]),
            "phone.lookup_settings": lambda p: phone_lookup.settings(),
            "phone.configure_lookup": lambda p: phone_lookup.configure(p),
            "phone.lookup_preview": lambda p: phone_lookup.preview(self._store(), p),
            "phone.lookup": lambda p: {"job_id": self._submit("phone_lookup", p)},
            "phone.lookup_history": lambda p: phone_lookup.history(self._store(), p.get("number"), p.get("offset", 0)),
        }

    # --- plumbing -------------------------------------------------------------------------------
    def handle(self, request: dict) -> dict:
        command = request.get("command")
        try:
            if request.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
                raise CommandError("unsupported_schema", f"Unsupported schema_version {request.get('schema_version')}")
            handler = self.commands.get(command)
            if handler is None:
                raise CommandError("unknown_command", f"Unknown command {command!r}")
            with self._lock:
                result = handler(request.get("payload") or {})
            return {"schema_version": SCHEMA_VERSION, "ok": True, "result": result}
        except CommandError as error:
            code, message = error.code, str(error)
        except (JobValidationError, ValueError) as error:
            code, message = "invalid_request", str(error)
        except KeyError as error:
            code, message = "invalid_request", f"Missing field {error}"
        except Exception as error:  # noqa: BLE001
            log("error", "command.failed", command=command, error=type(error).__name__, message=str(error))
            code, message = "internal_error", f"{type(error).__name__}: {error}"
        return {"schema_version": SCHEMA_VERSION, "ok": False, "error": {"code": code, "message": message}}

    def _store(self) -> ProjectStore:
        if self.store is None:
            raise CommandError("no_project", "Open or create a project first")
        return self.store

    def _project_id(self) -> str:
        self._store()
        return self.project["id"]

    def _runner(self) -> JobRunner:
        self._store()
        return self.runner

    def _submit(self, kind: str, params: dict) -> str:
        return self._runner().submit(self._store(), self._project_id(), kind, params)

    def _open(self, path: str, name: str | None = None, create: bool = False) -> dict:
        if self.runner and any(self.runner._controls):
            raise CommandError("jobs_active", "Wait for active jobs to finish or cancel them before switching projects")
        store, project = projects.open_project(path, self.migrations_dir, name, create)
        if self.store:
            self.store.close()
        self.store, self.project = store, project
        recovered = store.recover_interrupted_jobs()
        self.runner = JobRunner(store.database_path, {
            "dataset_import": JobKind(run=self._run_import, validate=self._validate_import),
            "skiptrace_scan": skiptrace.SCAN_JOB,
            "skiptrace_apply": skiptrace.APPLY_JOB,
            "geo_locate": geo.LOCATE_JOB,
            "dnc_registry_import": dnc_registry.IMPORT_JOB,
            "nanpa_blocks_import": nanpa_blocks.IMPORT_JOB,
            "phone_lookup": phone_lookup.LOOKUP_JOB,
            "lists_combine": combine.COMBINE_JOB,
            "project_backup": keeping.BACKUP_JOB,
        })
        # Lists that were in the project before imports left out empty rows and columns get the same treatment now.
        # Opening must not fail over it: a list that cannot be tidied stays as it was.
        try:
            tidied = tidy.tidy_project(store, project["id"])
        except Exception as error:  # noqa: BLE001
            log("warning", "project.tidy_failed", error=type(error).__name__, message=str(error))
            tidied = []
        # Lists deleted long enough ago are let go for good.
        try:
            keeping.purge(store, project["id"], older_than_days=keeping.KEEP_DAYS)
        except Exception as error:  # noqa: BLE001
            log("warning", "project.purge_failed", error=type(error).__name__, message=str(error))
        self.project = {**project, "tidied": tidied}
        return {**self.project, "recovered_jobs": recovered}

    def open_recent(self) -> None:
        recent = projects.recent_projects()
        if recent:
            try:
                self._open(recent[0]["root_path"])
            except Exception as error:  # noqa: BLE001 - startup must still succeed
                log("warning", "project.reopen_failed", error=str(error))

    # --- commands -------------------------------------------------------------------------------
    @staticmethod
    def _validate_import(store: ProjectStore, params: dict) -> dict:
        path = Path(str(params.get("path", "")))
        if path.suffix.lower() not in IMPORT_TYPES:
            raise JobValidationError(datasets.SUPPORTED_IMPORTS)
        if not path.is_absolute() or not path.is_file():
            raise JobValidationError("Import path must be an absolute path to an existing file")
        return {**params, "path": str(path.resolve())}

    @staticmethod
    def _run_import(context: JobContext) -> dict:
        """Turf: a file whose rows are already in the project is not added a second time, whatever it is called now
        and however its columns are named, unless the person asks for it (`allow_duplicate`). The answer says which
        list holds its rows; a file that is added says which lists it shares rows with."""
        store, params = context.store, context.params
        path = Path(params["path"])
        allowed = bool(params.get("allow_duplicate"))
        try:
            context.stage("reading_file")
            project_id = store.job(context.job_id)["project_id"]
            if not allowed:
                already = sameness.same_file(store, project_id, hashlib.sha256(path.read_bytes()).hexdigest())
                if already is not None:
                    return {"dataset_id": None, "already": already}
            imported = datasets.import_file(store, project_id, path, params.get("name"))
            # The import left out its empty rows and columns already, so opening the project need not look at it again.
            tidy.mark_checked(store, [imported.dataset_id])
            context.stage("comparing_with_lists")
            already, overlaps = sameness.compare(store, project_id, imported.dataset_id)
            if already is not None and not allowed:
                datasets.delete_dataset(store, imported.dataset_id)
                return {"dataset_id": None, "already": already}
            return {**asdict(imported), "already": None, "overlaps": overlaps}
        finally:
            if params.get("temporary"):
                shutil.rmtree(path.parent, ignore_errors=True)

    def _import_content(self, payload: dict) -> dict:
        """Turf: adds a file handed over as its content, for a browser tab, which knows a dropped file's bytes but
        not where it is on the disk. The desktop window gives the path and uses dataset.import."""
        name = Path(str(payload.get("name") or "")).name
        if Path(name).suffix.lower() not in IMPORT_TYPES:
            raise CommandError("invalid_request", datasets.SUPPORTED_IMPORTS)
        try:
            content = base64.b64decode(str(payload.get("data") or ""), validate=True)
        except ValueError as error:
            raise CommandError("invalid_request", "The file did not arrive whole") from error
        if len(content) > datasets.MAX_IMPORT_BYTES:
            raise CommandError("invalid_request", "Imported data exceeds the 50 MB safety limit")
        self._store()
        folder = projects.app_data_dir() / "dropped" / uuid4().hex
        folder.mkdir(parents=True)
        (folder / name).write_bytes(content)
        try:
            return {"job_id": self._submit("dataset_import", {"path": str(folder / name), "allow_duplicate": bool(payload.get("allow_duplicate")), "temporary": True})}
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            raise

    def _dataset_rename(self, payload: dict) -> dict:
        """Turf: gives a list another name. Only the name changes; the file it came from keeps its own."""
        name = " ".join(str(payload.get("name") or "").split())
        if not name:
            raise CommandError("invalid_request", "A list needs a name")
        if len(name) > 200:
            raise CommandError("invalid_request", "That name is too long (200 characters at most)")
        store = self._store()
        with store._connection:
            changed = store._connection.execute("UPDATE datasets SET name = ? WHERE id = ? AND project_id = ?", (name, payload["dataset_id"], self._project_id())).rowcount
        if not changed:
            raise CommandError("not_found", "Unknown list")
        return {"dataset_id": payload["dataset_id"], "name": name}

    def _job_get(self, payload: dict) -> dict:
        store = self._store()
        row = store.job(payload["job_id"])
        if row is None:
            raise CommandError("not_found", "Unknown job")
        events = [{**dict(e), "payload": json.loads(e["payload_json"])} for e in store.job_events(payload["job_id"], int(payload.get("after_event_id", 0)))]
        for event in events:
            event.pop("payload_json")
        return {**_job_dict(row), "events": events}
