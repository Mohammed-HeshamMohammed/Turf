"""Keeping a project safe: a deleted list can be brought back, the whole project can be backed up, and the filters
the person saved for a list are kept with it.

Turf's own.
"""

from __future__ import annotations

import json
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import datasets
from .jobs import JobContext, JobKind, JobValidationError
from .storage import ProjectStore, utc_now

KEEP_DAYS = 30
_FILTERS = "lists.filters"


# -------------------------------------------------------------------------------------------- deleted lists

def trash(store: ProjectStore, project_id: str, dataset_id: str) -> dict:
    """Takes a list out of the project without destroying it. It is set aside under a project of its own, so
    nothing that reads the project's lists (the Dashboard, other lists' phone checks, adding a file) sees it, and
    everything it had (rows, setup, stored file) is there when it is put back."""
    with store._connection:
        moved = store._connection.execute("UPDATE datasets SET project_id = ? WHERE id = ? AND project_id = ?", (f"trash:{project_id}", dataset_id, project_id)).rowcount
        if not moved:
            raise ValueError("This list is no longer in the project")
        store._connection.execute("INSERT OR REPLACE INTO trashed_datasets(dataset_id, project_id, deleted_at) VALUES (?, ?, ?)", (dataset_id, project_id, utc_now()))
    return {"deleted": dataset_id, "kept_days": KEEP_DAYS}


def trashed(store: ProjectStore, project_id: str) -> list[dict]:
    found = store._connection.execute(
        "SELECT d.id, d.name, d.kind, d.row_count, t.deleted_at FROM trashed_datasets t JOIN datasets d ON d.id = t.dataset_id WHERE t.project_id = ? ORDER BY t.deleted_at DESC", (project_id,)
    ).fetchall()
    return [{**dict(row), "kept_until": (datetime.fromisoformat(row["deleted_at"]) + timedelta(days=KEEP_DAYS)).isoformat()} for row in found]


def restore(store: ProjectStore, project_id: str, dataset_id: str) -> dict:
    with store._connection:
        back = store._connection.execute("UPDATE datasets SET project_id = ? WHERE id = ? AND project_id = ?", (project_id, dataset_id, f"trash:{project_id}")).rowcount
        if not back:
            raise ValueError("That list is no longer among the deleted ones")
        store._connection.execute("DELETE FROM trashed_datasets WHERE dataset_id = ?", (dataset_id,))
    return {"restored": dataset_id}


def purge(store: ProjectStore, project_id: str, dataset_id: str | None = None, older_than_days: int | None = None) -> dict:
    """Deletes for good: one deleted list, every deleted list, or those deleted more than some days ago."""
    limit = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat() if older_than_days is not None else None
    gone = []
    for item in trashed(store, project_id):
        if (dataset_id is None or item["id"] == dataset_id) and (limit is None or item["deleted_at"] < limit):
            datasets.delete_dataset(store, item["id"])
            with store._connection:
                store._connection.execute("DELETE FROM trashed_datasets WHERE dataset_id = ?", (item["id"],))
            gone.append(item["id"])
    return {"purged": gone}


# ------------------------------------------------------------------------------------------------- backups

def _validate_backup(store: ProjectStore, params: dict) -> dict:
    raw = str(params.get("path") or "")
    if not raw:
        stamp = datetime.now().strftime("%Y-%m-%d %H%M%S")
        return {"path": str(store.project_root / "backups" / f"Turf backup {stamp}.zip")}
    path = Path(raw)
    if not path.is_absolute() or not path.parent.is_dir() or path.suffix.lower() != ".zip":
        raise JobValidationError("Choose an existing folder and a file name ending in .zip")
    return {"path": str(path)}


def _run_backup(context: JobContext) -> dict:
    """One file holding the whole project: a consistent copy of its database, and every stored file beside it.
    Unpacked into an empty folder, it opens as the project."""
    store = context.store
    target = Path(context.params["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    copy = target.with_suffix(".sqlite3.tmp")
    partial = target.with_suffix(".zip.tmp")
    context.stage("copying_database")
    try:
        store.backup(copy)
        files = [path for path in (store.project_root / "artifacts").rglob("*") if path.is_file()] if (store.project_root / "artifacts").is_dir() else []
        with zipfile.ZipFile(partial, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(copy, store.database_path.name)
            for count, path in enumerate(files):
                if count % 20 == 0:
                    context.checkpoint()
                    context.stage("copying_files", {"completed": count, "total": len(files)})
                archive.write(path, path.relative_to(store.project_root).as_posix())
        partial.replace(target)
    finally:
        copy.unlink(missing_ok=True)
        partial.unlink(missing_ok=True)
    context.published = True
    return {"path": str(target), "size": target.stat().st_size, "files": len(files)}


BACKUP_JOB = JobKind(run=_run_backup, validate=_validate_backup)


# --------------------------------------------------------------------------------------------- saved filters

def _all_filters(store: ProjectStore) -> dict:
    row = store._connection.execute("SELECT value_json FROM project_settings WHERE key = ?", (_FILTERS,)).fetchone()
    return json.loads(row["value_json"]) if row else {}


def filters(store: ProjectStore, dataset_id: str) -> list[dict]:
    return _all_filters(store).get(dataset_id, [])


def save_filter(store: ProjectStore, dataset_id: str, name: object, value: object) -> list[dict]:
    """Keeps a filter under a name for a list; the same name again replaces it, and no value removes it."""
    name = " ".join(str(name or "").split())[:80]
    if not name:
        raise ValueError("Give the filter a name")
    if value is not None and not isinstance(value, dict):
        raise ValueError("A filter is what was chosen in the filter bar")
    everything = _all_filters(store)
    kept = [item for item in everything.get(dataset_id, []) if item["name"].casefold() != name.casefold()]
    if value is not None:
        kept.append({"name": name, "filter": value})
    everything[dataset_id] = sorted(kept, key=lambda item: item["name"].casefold())[:50]
    with store._connection:
        store._connection.execute(
            "INSERT INTO project_settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            (_FILTERS, json.dumps(everything, sort_keys=True), utc_now()),
        )
    return everything[dataset_id]
