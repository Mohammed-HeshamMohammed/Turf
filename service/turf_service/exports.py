"""Files made from a list for work outside Turf: the leads to call, for a dialer, and the addresses to mail.

Turf's own. A file is written to Turf's app-data folder under a one-time name and handed over the same two ways as a
list's own downloads: saved where the person chose (the desktop window), or read out in pieces (a browser tab).
"""

from __future__ import annotations

import base64
import csv
import json
import re
import shutil
import time
from pathlib import Path
from uuid import uuid4

from turf_matching import duplicates
from turf_matching.normalize import address

from . import leads
from .projects import app_data_dir
from .storage import ProjectStore

KINDS = ("calls", "mail")
_TOKEN = re.compile(r"^[0-9a-f]{32}$")
_PO_BOX = re.compile(r"\bp\.?\s*o\.?\s*box\b|\bpost office box\b|^box\s+\d", re.IGNORECASE)


def _folder() -> Path:
    path = app_data_dir() / "exports"
    path.mkdir(parents=True, exist_ok=True)
    # Yesterday's files have been saved or will not be.
    for old in path.glob("*.csv"):
        if time.time() - old.stat().st_mtime > 86400:
            old.unlink(missing_ok=True)
    return path


def _file(token: object) -> Path:
    if not _TOKEN.match(str(token)):
        raise ValueError("That export is no longer available. Make it again.")
    path = app_data_dir() / "exports" / f"{token}.csv"
    if not path.is_file():
        raise ValueError("That export is no longer available. Make it again.")
    return path


def _cell(row: dict, column: object) -> str:
    return str(row.get(column) or "").strip() if column else ""


def _name(row: dict, config: dict) -> str:
    return _cell(row, config.get("name_column")) or " ".join(part for part in (_cell(row, config.get("first_name_column")), _cell(row, config.get("last_name_column"))) if part)


def _street(value: str) -> str:
    """An address in one spelling: "12 Main Street" and "12 main st" are the same place."""
    parsed = address(value)
    return parsed["full"] if parsed else ""


def _calls(store: ProjectStore, dataset: dict, rows: list[tuple[int, dict]], config: dict, options: dict) -> tuple[list[str], list[dict], dict]:
    """One row for each lead worth calling: its best number first, then its other usable numbers."""
    if not rows or "Best phone" not in rows[0][1]:
        raise ValueError("Check this list's phones in Skip Tracing first: the call list is made from the check's results")
    known = leads.for_list(store, dataset["id"])
    skip_stages = set(options.get("skip_stages") if options.get("skip_stages") is not None else ("not_interested", "dead"))
    extra = [column for column in options.get("columns") or [] if column in rows[0][1]]
    columns = ["Name", "Phone", "Other phones", "Property Address", "City", "State", "Zip", "Stage", "Call back on", "Latest note", *extra, "Row"]
    latest = {row["lead_key"]: row["note"] for row in store._connection.execute("SELECT lead_key, note FROM lead_notes WHERE removed_at IS NULL ORDER BY at")}
    out, left = [], {"no_number": 0, "repeats": 0, "stage": 0}
    seen: set[str] = set()
    for number, row in rows:
        if not row.get("Best phone"):
            left["no_number"] += 1
            continue
        key = known["keys"].get(str(number), "")
        if str(row.get("Duplicate status") or "").startswith("Duplicate of") or key in seen:
            left["repeats"] += 1
            continue
        state = known["states"].get(key, {})
        if state.get("stage", "new") in skip_stages:
            left["stage"] += 1
            continue
        seen.add(key)
        best = str(row["Best phone"]).split(";")[0].strip()
        try:
            choices = json.loads(row.get("Phone choices") or "[]")
        except json.JSONDecodeError:
            choices = []
        others = list(dict.fromkeys(choice["number"] for choice in choices if choice.get("number") and not choice.get("blocked") and choice["number"] != best))
        out.append({
            "Name": _name(row, config), "Phone": best, "Other phones": "; ".join(others), "Property Address": _cell(row, config.get("address_column")),
            "City": _cell(row, config.get("city_column")), "State": _cell(row, config.get("state_column")), "Zip": _cell(row, config.get("zip_column")),
            "Stage": state.get("stage", "new").replace("_", " "), "Call back on": state.get("callback_on") or "", "Latest note": latest.get(key, ""),
            **{column: row.get(column, "") for column in extra}, "Row": number,
        })
    return columns, out, left


def _mail(dataset: dict, rows: list[tuple[int, dict]], config: dict, options: dict) -> tuple[list[str], list[dict], dict]:
    """One row for each owner at each mailing address: where a letter goes, and the property it is about."""
    mail = {key: config.get(f"mailing_{key}_column") for key in ("address", "city", "state", "zip")}
    own = not mail["address"]  # no mailing address in the list: a letter goes to the property itself
    columns = ["Name", "Mailing Address", "Mailing City", "Mailing State", "Mailing Zip", "Property Address", "Property City", "Property State", "Property Zip", "Row"]
    out, left = [], {"no_address": 0, "repeats": 0, "not_wanted": 0}
    seen: set[tuple] = set()
    for number, row in rows:
        site = [_cell(row, config.get(f"{key}_column")) for key in ("address", "city", "state", "zip")]
        to = site if own else [_cell(row, mail[key]) for key in ("address", "city", "state", "zip")]
        if not to[0]:
            to = site
        if not to[0]:
            left["no_address"] += 1
            continue
        absentee = bool(site[0]) and _street(to[0]) != _street(site[0])
        phones = any(_cell(row, column) for column in config.get("phone_columns") or [])
        if (options.get("absentee_only") and not absentee) or (options.get("no_phone_only") and phones) or (options.get("skip_po_boxes") and _PO_BOX.search(to[0])):
            left["not_wanted"] += 1
            continue
        name = _name(row, config)
        key = (frozenset(duplicates.text(name).split()), _street(to[0]), to[3][:5])
        if key in seen:
            left["repeats"] += 1
            continue
        seen.add(key)
        out.append(dict(zip(columns, [name, *to, *site, number])))
    return columns, out, left


def prepare(store: ProjectStore, payload: dict) -> dict:
    kind = payload.get("kind")
    if kind not in KINDS:
        raise ValueError("Choose what to export")
    dataset = store._connection.execute("SELECT * FROM datasets WHERE id = ?", (payload.get("dataset_id"),)).fetchone()
    if dataset is None:
        raise ValueError("This list is no longer in the project")
    dataset = dict(dataset)
    rows = [(row["source_row_number"], json.loads(row["raw_values_json"])) for row in store._connection.execute(
        "SELECT source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ? ORDER BY source_row_number", (dataset["id"],))]
    config = leads._config_of(store, dataset)
    options = dict(payload.get("options") or {})
    columns, out, left = _calls(store, dataset, rows, config, options) if kind == "calls" else _mail(dataset, rows, config, options)
    token = uuid4().hex
    path = _folder() / f"{token}.csv"
    with path.open("w", encoding="utf-8-sig", newline="") as handle:  # the mark lets a spreadsheet read names in any script
        writer = csv.DictWriter(handle, fieldnames=columns, lineterminator="\r\n")
        writer.writeheader()
        writer.writerows(out)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", dataset["name"]).strip(" .")[:140] or "list"
    return {"token": token, "filename": f"{name} ({'to call' if kind == 'calls' else 'to mail'}).csv", "size": path.stat().st_size, "rows": len(out), "left_out": left}


def chunk(payload: dict) -> dict:
    path = _file(payload.get("token"))
    offset = int(payload.get("offset", 0))
    if offset < 0 or offset > path.stat().st_size:
        raise ValueError("Invalid download offset")
    with path.open("rb") as handle:
        handle.seek(offset)
        return {"data": base64.b64encode(handle.read(1024 * 1024)).decode("ascii")}


def save(store: ProjectStore, payload: dict) -> dict:
    source = _file(payload.get("token"))
    target = Path(str(payload.get("path") or ""))
    if not target.is_absolute() or not target.parent.is_dir():
        raise ValueError("Choose an existing folder to save the file")
    if target.resolve().is_relative_to(store.project_root.resolve()):
        raise ValueError("Save exports outside the project folder to protect its stored files")
    shutil.copyfile(source, target)
    return {"saved": True}
