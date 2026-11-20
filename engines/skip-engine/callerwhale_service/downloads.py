"""Project-backed original files and complete, immutable checked CSV downloads."""
from __future__ import annotations

import base64
import csv
import hashlib
import io
import json
import mimetypes
import re
import shutil
import tempfile
from pathlib import Path

from .datasets import _store_artifact


def _dataset(store, dataset_id):
    row = store._connection.execute("SELECT * FROM datasets WHERE id=?", (dataset_id,)).fetchone()
    if row is None:
        raise ValueError("This list is no longer in the project")
    return dict(row)


def original_file(store, dataset_id, seen=None):
    seen = set() if seen is None else seen
    if dataset_id in seen:
        raise ValueError("The original file reference is invalid")
    seen.add(dataset_id)
    dataset = _dataset(store, dataset_id)
    if dataset["kind"] == "checked":
        derivation = json.loads(dataset["derivation_json"] or "{}")
        if derivation.get("original_file"):
            return derivation["original_file"]
        if dataset.get("parent_dataset_id"):
            return original_file(store, dataset["parent_dataset_id"], seen)
        raise ValueError("The original file is unavailable for this older copy")
    return {"hash": dataset["source_artifact_hash"], "filename": dataset["source_filename"]}


def _artifact(store, reference):
    digest = reference["hash"]
    suffix = Path(reference["filename"]).suffix.lower()
    if not re.fullmatch(r"[0-9a-f]{64}", digest) or not re.fullmatch(r"\.[a-z0-9]+", suffix):
        raise ValueError("The saved file reference is invalid")
    path = store.project_root / "artifacts" / "sha256" / digest[:2] / f"{digest}{suffix}"
    if not path.is_file():
        raise ValueError("The saved file is missing from this project. Restore the project's artifacts folder from your backup.")
    return path


def archive_csv(store, columns, rows):
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, extrasaction="raise", lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)
    # UTF-8 BOM lets spreadsheet applications recognize names and non-English text.
    content = output.getvalue().encode("utf-8-sig")
    return {"hash": _store_artifact(store, content, ".csv"), "filename": "checked.csv"}


def _reference(store, dataset_id, version):
    if version == "original":
        return original_file(store, dataset_id)
    if version != "checked":
        raise ValueError("Choose the original file or a checked copy")
    dataset = _dataset(store, dataset_id)
    if dataset["kind"] != "checked":
        raise ValueError("Select a saved checked copy to download its results")
    derivation = json.loads(dataset["derivation_json"] or "{}")
    reference = derivation.get("checked_file")
    if reference is None:
        # Older copies already have a permanent JSON snapshot; export that snapshot, never re-run tracing.
        snapshot = json.loads(_artifact(store, {"hash": dataset["source_artifact_hash"], "filename": dataset["source_filename"]}).read_text("utf-8"))
        rows = snapshot["rows"]
        columns = list(dict.fromkeys(column for row in rows for column in row))
        reference = archive_csv(store, columns, rows)
        derivation["checked_file"] = reference
        with store._connection:
            store._connection.execute("UPDATE datasets SET derivation_json=? WHERE id=?", (json.dumps(derivation, sort_keys=True), dataset_id))
    filename = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", dataset["name"]).strip(" .")[:160] or "checked"
    return {**reference, "filename": f"{filename}.csv"}


def prepare(store, dataset_id, version):
    reference = _reference(store, dataset_id, version)
    path = _artifact(store, reference)
    # Fail visibly on corruption rather than returning a damaged original or changed results.
    with path.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != reference["hash"]:
            raise ValueError("The saved file failed its integrity check. Restore it from your project backup.")
    return {"filename": Path(reference["filename"]).name, "size": path.stat().st_size, "mime": mimetypes.guess_type(reference["filename"])[0] or "application/octet-stream", "hash": reference["hash"]}


def chunk(store, dataset_id, version, offset, expected_hash):
    reference = _reference(store, dataset_id, version)
    if reference["hash"] != expected_hash:
        raise ValueError("The selected download changed. Start the download again.")
    path = _artifact(store, reference)
    if offset < 0 or offset > path.stat().st_size:
        raise ValueError("Invalid download offset")
    with path.open("rb") as file:
        file.seek(offset)
        content = file.read(1024 * 1024)
    return {"data": base64.b64encode(content).decode("ascii")}


def save(store, dataset_id, version, destination, expected_hash):
    info = prepare(store, dataset_id, version)
    if info["hash"] != expected_hash:
        raise ValueError("The selected download changed. Start the download again.")
    target = Path(destination)
    if not target.is_absolute() or not target.parent.is_dir():
        raise ValueError("Choose an existing folder to save the download")
    # Never allow a download to overwrite the project database or its retained originals.
    if target.resolve().is_relative_to(store.project_root.resolve()):
        raise ValueError("Save downloads outside the project folder to protect its stored files")
    source = _artifact(store, _reference(store, dataset_id, version))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as file:
            temporary = Path(file.name)
            with source.open("rb") as original:
                shutil.copyfileobj(original, file)
        temporary.replace(target)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return {"filename": info["filename"], "saved": True}
