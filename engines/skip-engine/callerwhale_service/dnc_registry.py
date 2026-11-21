"""The National Do Not Call Registry, from the files the person downloads at telemarketing.donotcall.gov.

Telemarketers get their first five area codes free (they register and renew each year). The FTC hands the numbers out
as files: flat text, possibly zipped, or XML, one area code or several. Caller Whale reads ten-digit numbers from such a file,
line by line, whatever the punctuation, and keeps them on this computer (the registry is national, so every project
uses the same copy). A file replaces the numbers of the area codes it holds, so a fresh download simply refreshes them.

A phone check then treats a number on the registry like any do-not-call evidence: it is blocked, with the file's date
as the reason. Numbers in area codes that were not imported are not checked, and the status says which ones are. The
rules want a copy no older than 31 days; an older one still blocks, and the screen asks for a fresh download.
"""

from __future__ import annotations

import io
import json
import re
import threading
import zipfile
from array import array
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .jobs import JobContext, JobKind, JobValidationError
from .projects import app_data_dir
from .storage import ProjectStore

MAX_AGE_DAYS = 31
SUFFIXES = (".txt", ".csv", ".zip", ".xml", ".dat")
_RUN = re.compile(r"(?<!\d)1?\d{10}(?!\d)")
_lock = threading.Lock()
_loaded: dict[tuple[str, str], array] = {}  # (folder, area code) -> its numbers, sorted


def _folder() -> Path:
    return app_data_dir() / "dnc-registry"


def _meta() -> dict:
    path = _folder() / "registry.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"area_codes": {}}


def _write_meta(meta: dict) -> None:
    path = _folder() / "registry.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(".part")
    partial.write_text(json.dumps(meta, indent=2, sort_keys=True), encoding="utf-8")
    partial.replace(path)


def numbers_in(line: str) -> list[str]:
    """The ten-digit numbers on one line: runs of digits ("7135551234"), or one number written with separators."""
    found = [run[-10:] for run in _RUN.findall(line)]
    if found:
        return found
    digits = re.sub(r"\D", "", line)
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return [digits] if len(digits) == 10 else []


def _lines(path: Path):
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                if member.is_dir() or not member.filename.lower().endswith(SUFFIXES):
                    continue
                with archive.open(member) as handle:
                    yield from io.TextIOWrapper(handle, encoding="utf-8", errors="replace")
    else:
        with path.open(encoding="utf-8", errors="replace") as handle:
            yield from handle


def import_file(path: Path, checkpoint=lambda done: None) -> dict:
    """Reads a registry file and replaces the numbers of every area code it holds."""
    by_code: dict[str, set[int]] = defaultdict(set)
    lines = skipped = 0
    for line in _lines(path):
        lines += 1
        found = numbers_in(line)
        if not found and line.strip():
            skipped += 1
        for number in found:
            if number[0] in "01":  # no NANP area code starts with 0 or 1
                continue
            by_code[number[:3]].add(int(number[3:]))
        if lines % 200_000 == 0:
            checkpoint(lines)
    if not by_code:
        raise ValueError("No ten-digit phone numbers were found in this file")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    folder = _folder()
    folder.mkdir(parents=True, exist_ok=True)
    meta = _meta()
    for code, numbers in by_code.items():
        values = array("I", sorted(numbers))
        partial = folder / f"{code}.part"
        partial.write_bytes(values.tobytes())
        partial.replace(folder / f"{code}.bin")
        meta["area_codes"][code] = {"count": len(values), "imported_at": now, "file": path.name}
    _write_meta(meta)
    with _lock:
        _loaded.clear()
    return {"area_codes": sorted(by_code), "numbers": sum(len(numbers) for numbers in by_code.values()), "lines": lines, "skipped_lines": skipped}


def remove(code: object) -> dict:
    code = str(code)
    if not re.fullmatch(r"[2-9]\d\d", code):
        raise ValueError("Not an area code")
    meta = _meta()
    meta["area_codes"].pop(code, None)
    (_folder() / f"{code}.bin").unlink(missing_ok=True)
    _write_meta(meta)
    with _lock:
        _loaded.clear()
    return status()


def status() -> dict:
    """The area codes on this computer, how many numbers each holds, and how old its file is."""
    now = datetime.now(timezone.utc)
    codes = []
    for code, entry in sorted(_meta()["area_codes"].items()):
        age = (now - datetime.fromisoformat(entry["imported_at"])).days
        codes.append({**entry, "area_code": code, "age_days": age, "out_of_date": age > MAX_AGE_DAYS})
    return {"area_codes": codes, "numbers": sum(entry["count"] for entry in codes), "max_age_days": MAX_AGE_DAYS}


def _numbers(code: str) -> array | None:
    key = (str(_folder()), code)
    with _lock:
        if key not in _loaded:
            path = _folder() / f"{code}.bin"
            values = array("I")
            if path.is_file():
                values.frombytes(path.read_bytes())
            _loaded[key] = values
        return _loaded[key] or None


def listed(e164: str) -> str | None:
    """The reason a number is on the registry, or None. Only +1 numbers in imported area codes are checked."""
    if not e164 or not e164.startswith("+1") or len(e164) != 12:
        return None
    code, rest = e164[2:5], int(e164[5:])
    numbers = _numbers(code)
    if not numbers:
        return None
    index = bisect_left(numbers, rest)
    if index < len(numbers) and numbers[index] == rest:
        entry = _meta()["area_codes"].get(code, {})
        return f"National Do Not Call Registry (file of {str(entry.get('imported_at', ''))[:10]})"
    return None


class WithRegistry(defaultdict):
    """Do-not-call evidence gathered from the project, with the registry asked for every number looked up."""

    def __init__(self, gathered: dict):
        super().__init__(list, gathered)

    def get(self, key, default=None):
        found = super().get(key)
        reason = listed(key)
        if reason:
            return [*(found or []), (reason, None)]
        return found if found is not None else default


def fingerprint() -> dict:
    """What a check depends on: which area codes, from which import."""
    return {code: entry["imported_at"] for code, entry in _meta()["area_codes"].items()}


# ---------------------------------------------------------------------------------------------------- the job

def _validate(store: ProjectStore, params: dict) -> dict:
    path = Path(str(params.get("path") or ""))
    if not path.is_file():
        raise JobValidationError("Choose the registry file you downloaded")
    if path.suffix.lower() not in SUFFIXES:
        raise JobValidationError("The registry file should be a .txt, .csv, .xml or .zip file")
    return {"path": str(path)}


def _run(context: JobContext) -> dict:
    context.stage("reading_registry", {"lines": 0})

    def progress(lines: int) -> None:
        context.checkpoint()
        context.stage("reading_registry", {"lines": lines})

    return import_file(Path(context.params["path"]), progress)


IMPORT_JOB = JobKind(run=_run, validate=_validate)
