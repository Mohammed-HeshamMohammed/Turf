"""Combining lists into one, and what the person decided about rows being the same lead.

Turf's own. The comparing is turf_matching/combine.py and duplicates.py; this reads the lists and their setups from
the project, keeps the person's decisions in DataForge's `match_constraints` table (the same table its review queue
writes, so the schema is unchanged), and saves the combined list as a list of its own.
"""

from __future__ import annotations

import csv
import io
import json
import re
from pathlib import Path
from uuid import uuid4

from turf_matching import combine as engine
from turf_matching import skiptrace as rules

from .cleaning import MAX_ROWS, _roles, _rows
from .datasets import _register_rows
from .jobs import JobContext, JobKind, JobValidationError
from .storage import ProjectStore, utc_now

MODES = ("all", "shared", "in_all")
MAX_LISTS = 10


# ------------------------------------------------------------------------------------------ the person's decisions

def _row_id(store: ProjectStore, dataset_id: object, row_number: object) -> str:
    row = store._connection.execute("SELECT id FROM source_rows WHERE dataset_id = ? AND source_row_number = ?", (dataset_id, int(row_number))).fetchone()
    if row is None:
        raise ValueError("That row is not in the list")
    return row["id"]


def overrule(store: ProjectStore, payload: dict) -> dict:
    """Records that two rows are (`same` true) or are not (`same` false) the same lead, or forgets what was said
    about them (`same` null). The two rows may be in different lists. What was said before about the pair is kept,
    marked as withdrawn."""
    dataset_id = payload["dataset_id"]
    left = _row_id(store, dataset_id, payload["row_number"])
    right = _row_id(store, payload.get("other_dataset_id") or dataset_id, payload["other_row_number"])
    if left == right:
        raise ValueError("Choose two different rows")
    same = payload.get("same")
    if same not in (True, False, None):
        raise ValueError("Say whether the rows are the same lead")
    now = utc_now()
    with store._connection:
        store._connection.execute(
            "UPDATE match_constraints SET revoked_at = ? WHERE revoked_at IS NULL AND ((left_row_id = ? AND right_row_id = ?) OR (left_row_id = ? AND right_row_id = ?))",
            (now, left, right, right, left),
        )
        if same is not None:
            store._connection.execute(
                "INSERT INTO match_constraints(id, dataset_id, left_row_id, right_row_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (str(uuid4()), dataset_id, left, right, "must_link" if same else "must_not_link", now),
            )
    return {"overrules": overrules(store, [dataset_id])}


def overrules(store: ProjectStore, dataset_ids: list[str]) -> list[dict]:
    """What the person decided about pairs of rows that are both in these lists, newest first."""
    if not dataset_ids:
        return []
    marks = ",".join("?" * len(dataset_ids))
    found = store._connection.execute(
        f"""SELECT c.kind, c.created_at, l.dataset_id AS left_dataset, l.source_row_number AS left_row, r.dataset_id AS right_dataset, r.source_row_number AS right_row
            FROM match_constraints c JOIN source_rows l ON l.id = c.left_row_id JOIN source_rows r ON r.id = c.right_row_id
            WHERE c.revoked_at IS NULL AND l.dataset_id IN ({marks}) AND r.dataset_id IN ({marks}) ORDER BY c.created_at DESC, c.id""",
        [*dataset_ids, *dataset_ids],
    ).fetchall()
    return [{"same": row["kind"] == "must_link", "at": row["created_at"], "dataset_id": row["left_dataset"], "row_number": row["left_row"],
             "other_dataset_id": row["right_dataset"], "other_row_number": row["right_row"]} for row in found]


def decided(store: ProjectStore, dataset_id: str) -> tuple[list[tuple[int, int]], list[tuple[int, int]]]:
    """(pairs of row numbers said to be the same lead, pairs said not to be), within one list."""
    found = overrules(store, [dataset_id])
    return ([(item["row_number"], item["other_row_number"]) for item in found if item["same"]],
            [(item["row_number"], item["other_row_number"]) for item in found if not item["same"]])


# ------------------------------------------------------------------------------------------------ combining lists

_ROLE_KEYS = {
    "name": "name_column", "first_name": "first_name_column", "last_name": "last_name_column", "address": "address_column",
    "mailing_address": "mailing_address_column", "city": "city_column", "region": "state_column", "postal_code": "zip_column",
}
# What lists that were never set up call their columns: a county roll's "Owner", "Site Address" and "Mail Address".
_HEADERS = (
    ("mailing_address_column", re.compile(r"^(owner)?mail(ing)?(addr|address|street)(line)?1?$")),
    ("address_column", re.compile(r"^((site|situs|property|prop|street|physical|location)(addr|address)(line)?1?|address1?|situs)$")),
    ("name_column", re.compile(r"^(owner1?(full)?(name)?|(full|contact|taxpayer|lead)?name|mailto|taxpayer)$")),
    ("first_name_column", re.compile(r"^(owner1?)?(first|given)name$")),
    ("last_name_column", re.compile(r"^(owner1?)?(last|sur|family)name$")),
    ("city_column", re.compile(r"^((site|situs|property|prop)?city)$")),
    ("state_column", re.compile(r"^((site|situs|property|prop)?state)$")),
    ("zip_column", re.compile(r"^((site|situs|property|prop)?(zip|zipcode|postalcode|postcode))$")),
)


def _config(store: ProjectStore, dataset_id: str, rows: list[dict]) -> dict:
    """What each column of a list is, for comparing its rows with other lists': its saved Skip Tracing setup, or the
    one Turf would suggest, with whatever those leave unsaid read from the columns' names. A list need not have been
    through Skip Tracing, nor have phones at all, to be combined."""
    from .skiptrace import get_settings
    columns = list(dict.fromkeys(column for row in rows[:400] for column in row))
    proposed = _roles(store, dataset_id, columns)[0]
    config = dict(get_settings(store, dataset_id) or rules.suggest(rows, proposed)["config"])
    taken = {value for value in config.values() if isinstance(value, str)} | set(config.get("phone_columns") or [])
    for column, role in proposed.items():
        key = _ROLE_KEYS.get(role or "")
        if key and not config.get(key) and column in columns and column not in taken:
            config[key] = column
            taken.add(column)
    for column in columns:
        header = re.sub(r"[^a-z0-9]", "", column.casefold())
        for key, pattern in _HEADERS:
            if not config.get(key) and column not in taken and pattern.match(header):
                config[key] = column
                taken.add(column)
                break
    return config


def _checked(store: ProjectStore, dataset_id: str, numbers: list[int]) -> list[dict] | None:
    """The list's rows as its newest phone check wrote them, in the list's own order, when it has been checked."""
    copy = store._connection.execute(
        "SELECT id FROM datasets WHERE parent_dataset_id = ? AND kind = 'checked' ORDER BY created_at DESC, id DESC LIMIT 1", (dataset_id,)
    ).fetchone()
    if copy is None:
        return None
    by_number = {row["source_row_number"]: json.loads(row["raw_values_json"]) for row in store._connection.execute(
        "SELECT source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ?", (copy["id"],))}
    return [by_number.get(number, {}) for number in numbers]


def _validate(store: ProjectStore, params: dict) -> dict:
    ids = list(dict.fromkeys(str(item) for item in params.get("dataset_ids") or []))
    if not 2 <= len(ids) <= MAX_LISTS:
        raise JobValidationError(f"Choose from 2 to {MAX_LISTS} lists to combine")
    marks = ",".join("?" * len(ids))
    found = {row["id"]: row for row in store._connection.execute(f"SELECT id, name, kind FROM datasets WHERE id IN ({marks})", ids)}
    if len(found) != len(ids):
        raise JobValidationError("One of the lists is no longer in the project")
    if any(row["kind"] == "checked" for row in found.values()):
        raise JobValidationError("Combine the lists themselves, not their checked copies; a checked list's results are used by themselves")
    mode = str(params.get("mode") or "all")
    if mode not in MODES and not (mode.startswith("only:") and mode[5:] in ids):
        raise JobValidationError("Choose what the combined list holds")
    name = " ".join(str(params.get("name") or "").split())[:200] or " + ".join(found[item]["name"] for item in ids)[:200]
    return {"dataset_ids": ids, "mode": mode, "name": name, "preview": bool(params.get("preview"))}


def _run(context: JobContext) -> dict:
    store, params = context.store, context.params
    ids = params["dataset_ids"]
    context.stage("reading_lists")
    lists = []
    project_id = None
    for dataset_id in ids:
        dataset = store._connection.execute("SELECT id, name, project_id FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
        project_id = dataset["project_id"]
        numbers, rows = _rows(store, dataset_id)
        lists.append({"id": dataset_id, "name": dataset["name"], "rows": rows, "numbers": numbers, "config": _config(store, dataset_id, rows), "checked": _checked(store, dataset_id, numbers)})
        context.checkpoint()
    if sum(len(item["rows"]) for item in lists) > MAX_ROWS:
        raise ValueError(f"Lists of up to {MAX_ROWS:,} rows together can be combined")
    position = {dataset_id: at for at, dataset_id in enumerate(ids)}
    found = overrules(store, ids)

    def pairs(same: bool) -> list:
        return [((position[item["dataset_id"]], item["row_number"]), (position[item["other_dataset_id"]], item["other_row_number"])) for item in found if item["same"] is same]

    mode = params["mode"]
    engine_mode = f"only:{position[mode[5:]]}" if mode.startswith("only:") else mode
    columns, rows, summary = engine.combine(lists, engine_mode, pairs(True), pairs(False), context.checkpoint, context.stage)
    summary["mode"] = mode
    for item, counted in zip(lists, summary["lists"]):
        counted["dataset_id"] = item["id"]
    for example in [*summary["examples"], *summary["possible"], *summary["owner_differs_examples"]]:
        for row in example["rows"]:
            row["dataset_id"] = ids[row.pop("list")]
            row["list"] = lists[position[row["dataset_id"]]]["name"]
    if params["preview"]:
        return {"summary": summary}
    if not rows:
        raise ValueError("No lead fits that choice, so there is nothing to save")
    # A column nothing was written in (no other emails, say) is left out of the new list.
    columns = [column for column in columns if any(row.get(column) not in (None, "") for row in rows)]
    rows = [{column: row.get(column, "") for column in columns} for row in rows]
    context.stage("saving_combined_list", {"rows": len(rows)})
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator="\r\n")
    writer.writeheader()
    writer.writerows(rows)
    derivation = {"combine_version": engine.COMBINE_VERSION, "combined_from": [{"dataset_id": item["id"], "name": item["name"], "rows": len(item["rows"])} for item in lists],
                  "mode": mode, "summary": {key: summary[key] for key in ("counts", "rows_in", "rows_out", "overruled")}, "combined_at": utc_now()}
    context.checkpoint()
    store._connection.execute("BEGIN IMMEDIATE")
    try:
        created = _register_rows(store, project_id, Path(f"{params['name']}.csv"), output.getvalue().encode("utf-8-sig"), columns, rows, params["name"], kind="combined", commit=False)
        store._connection.execute("UPDATE datasets SET derivation_json = ? WHERE id = ?", (json.dumps(derivation, sort_keys=True), created.dataset_id))
        context.checkpoint()
        store._connection.commit()
        context.published = True
    except BaseException:
        store._connection.rollback()
        raise
    return {"dataset_id": created.dataset_id, "rows": len(rows), "columns": len(columns), "summary": summary}


COMBINE_JOB = JobKind(run=_run, validate=_validate)
