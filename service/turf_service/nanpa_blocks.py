"""Which phone number blocks (area code + the next three digits, "NPA-NXX") are assigned to a carrier, from NANPA's
central office code assignment files, which the person downloads at nanpa.com in their own browser (the site turns away
programs, and may need a US VPN).

Turf reads any such file loosely: tab, comma or pipe columns, with or without a header, "713-555" or "713" and "555"
apart. A row whose status says the code is free (VC, UA, available, vacant), or every row of a file of available codes,
counts as unassigned; any other row counts as assigned. A file replaces the area codes it holds.

A phone check then marks a number suspicious when its area code is in the file and its block is not assigned to any
carrier: no one can have that number. Suspicious, not wrong, because blocks keep being assigned after a file is made.
"""

from __future__ import annotations

import csv
import json
import re
import threading
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .jobs import JobContext, JobKind, JobValidationError
from .projects import app_data_dir
from .storage import ProjectStore

SUFFIXES = (".txt", ".csv", ".zip", ".tsv", ".dat")
FREE = {"VC", "UA", "AV", "AVAILABLE", "VACANT", "UNASSIGNED", "SPARE"}
_BLOCK = re.compile(r"(?<!\d)([2-9]\d\d)[-\s.]?([2-9]\d\d)(?!\d)")
_lock = threading.Lock()
_loaded: dict[str, dict] = {}


def _path() -> Path:
    return app_data_dir() / "nanpa-blocks.json"


def _read() -> dict:
    with _lock:
        key = str(_path())
        if key not in _loaded:
            try:
                _loaded[key] = json.loads(_path().read_text(encoding="utf-8"))
            except (OSError, ValueError):
                _loaded[key] = {"area_codes": {}}
        return _loaded[key]


def _write(data: dict) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    partial.write_text(json.dumps(data), encoding="utf-8")
    partial.replace(path)
    with _lock:
        _loaded.pop(str(path), None)


def _texts(path: Path):
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                if not member.is_dir() and member.filename.lower().endswith(SUFFIXES):
                    yield member.filename, archive.read(member).decode("utf-8", errors="replace")
    else:
        yield path.name, path.read_text(encoding="utf-8", errors="replace")


def read_blocks(name: str, text: str) -> dict[str, dict[str, set[str]]]:
    """{area code: {"assigned": {nxx}, "free": {nxx}}} from one file's text."""
    all_free = "avail" in name.lower()
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        return {}
    delimiter = "\t" if "\t" in lines[0] else "|" if "|" in lines[0] else ","
    header = [cell.strip().casefold() for cell in next(csv.reader([lines[0]], delimiter=delimiter))]
    has_header = not _BLOCK.search(lines[0]) and any(re.search(r"[a-z]", cell) for cell in header)
    status_at = next((index for index, cell in enumerate(header) if cell in ("use", "status", "code status")), None) if has_header else None
    npa_at = next((index for index, cell in enumerate(header) if cell in ("npa", "area code")), None) if has_header else None
    nxx_at = next((index for index, cell in enumerate(header) if cell in ("nxx", "co code", "prefix")), None) if has_header else None
    blocks: dict[str, dict[str, set[str]]] = defaultdict(lambda: {"assigned": set(), "free": set()})
    for line in lines[1:] if has_header else lines:
        cells = next(csv.reader([line], delimiter=delimiter))
        if npa_at is not None and nxx_at is not None and max(npa_at, nxx_at) < len(cells):
            found = re.fullmatch(r"([2-9]\d\d)([2-9]\d\d)", cells[npa_at].strip() + cells[nxx_at].strip())
            npa, nxx = (found.group(1), found.group(2)) if found else (None, None)
        else:
            found = _BLOCK.search(line)
            npa, nxx = (found.group(1), found.group(2)) if found else (None, None)
        if not npa:
            continue
        status = cells[status_at].strip().upper() if status_at is not None and status_at < len(cells) else ""
        blocks[npa]["free" if all_free or status in FREE else "assigned"].add(nxx)
    return blocks


def import_file(path: Path) -> dict:
    found: dict[str, dict[str, set[str]]] = defaultdict(lambda: {"assigned": set(), "free": set()})
    for name, text in _texts(path):
        for npa, block in read_blocks(name, text).items():
            found[npa]["assigned"] |= block["assigned"]
            found[npa]["free"] |= block["free"]
    if not found:
        raise ValueError("No number blocks (area code and prefix) were found in this file")
    data = _read()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    codes = data.setdefault("area_codes", {})
    for npa, block in found.items():
        entry = codes.setdefault(npa, {"assigned": [], "free": []})
        # a file of assigned codes replaces the area code's; a file of available codes only takes those out of it
        assigned = block["assigned"] if block["assigned"] else set(entry["assigned"]) - block["free"]
        free = block["free"] if block["assigned"] else set(entry.get("free", [])) | block["free"]
        codes[npa] = {"assigned": sorted(assigned), "free": sorted(free - assigned), "imported_at": now, "file": path.name}
    _write(data)
    return {"area_codes": len(found), "assigned": sum(len(block["assigned"]) for block in found.values()), "free": sum(len(block["free"]) for block in found.values())}


def status() -> dict:
    codes = _read().get("area_codes", {})
    dates = sorted(entry["imported_at"] for entry in codes.values())
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(dates[0])).days if dates else None
    return {"area_codes": len(codes), "assigned": sum(len(entry["assigned"]) for entry in codes.values()), "oldest_days": age,
            "files": sorted({entry["file"] for entry in codes.values()})}


def unassigned(e164: str) -> str | None:
    """Why a +1 number cannot exist, when its area code is known and its block is not assigned; else None."""
    if not e164 or not e164.startswith("+1") or len(e164) != 12:
        return None
    entry = _read().get("area_codes", {}).get(e164[2:5])
    if not entry or not entry["assigned"] or e164[5:8] in entry["assigned"]:
        return None
    return f"The block {e164[2:5]}-{e164[5:8]} is not assigned to any carrier (NANPA file of {entry['imported_at'][:10]})"


def fingerprint() -> dict:
    return {npa: entry["imported_at"] for npa, entry in _read().get("area_codes", {}).items()}


def _validate(store: ProjectStore, params: dict) -> dict:
    path = Path(str(params.get("path") or ""))
    if not path.is_file():
        raise JobValidationError("Choose the NANPA file you downloaded")
    if path.suffix.lower() not in SUFFIXES:
        raise JobValidationError("The NANPA file should be a .txt, .csv or .zip file")
    return {"path": str(path)}


def _run(context: JobContext) -> dict:
    context.stage("reading_blocks", {})
    return import_file(Path(context.params["path"]))


IMPORT_JOB = JobKind(run=_run, validate=_validate)
