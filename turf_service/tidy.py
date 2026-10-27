"""Takes the empty rows and columns out of lists that were already in a project.

A file imported by Turf leaves them out as it comes in (datasets._register_rows). This does the same, once, for
imported lists that got into the project another way: before Turf did that, or through DataForge. It runs when a
project is opened.

A list is only touched when nothing else in the project depends on its shape. One that has copies, a mapping, a match
run or anything else pointing at it is left exactly as it is. The file a list came from is kept whole in the project
either way, so nothing that held data is lost.

This file is Turf's own; it is not a copy from DataForge.
"""

from __future__ import annotations

import json

from .datasets import _without_empty
from .storage import ProjectStore, utc_now

# Where the lists already looked at are remembered, so each is read through only once.
SETTING = "turf.lists_checked_for_empty"

# Every place another part of a project can point at a list. A list found in any of these is left alone.
REFERENCES = (
    ("datasets", "parent_dataset_id"),
    ("mapping_versions", "dataset_id"),
    ("match_runs", "dataset_id"),
    ("match_runs", "compare_dataset_id"),
    ("match_constraints", "dataset_id"),
    ("cluster_actions", "dataset_id"),
    ("ranking_models", "dataset_id"),
    ("canonical_overrides", "dataset_id"),
    ("mapping_flags", "dataset_id"),
    ("automation_workflows", "dataset_id"),
    ("watch_runs", "dataset_id"),
    ("watch_runs", "previous_dataset_id"),
)


def _checked(store: ProjectStore) -> set[str]:
    row = store._connection.execute("SELECT value_json FROM project_settings WHERE key = ?", (SETTING,)).fetchone()
    return set(json.loads(row["value_json"])) if row else set()


def mark_checked(store: ProjectStore, dataset_ids: list[str]) -> None:
    """Remembers lists that need no further look: ones just imported by Turf, and ones this module has been through."""
    known = _checked(store) | set(dataset_ids)
    with store._connection:
        store._connection.execute(
            "INSERT INTO project_settings(key, value_json, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            (SETTING, json.dumps(sorted(known)), utc_now()),
        )


def _in_use(store: ProjectStore, dataset_id: str) -> bool:
    return any(
        store._connection.execute(f"SELECT 1 FROM {table} WHERE {column} = ? LIMIT 1", (dataset_id,)).fetchone() is not None
        for table, column in REFERENCES
    )


def _named_in_setup(store: ProjectStore, dataset_id: str) -> set[str]:
    """Every column a saved Skip Tracing setup for the list refers to."""
    row = store._connection.execute("SELECT config_json FROM skiptrace_settings WHERE dataset_id = ?", (dataset_id,)).fetchone()
    if row is None:
        return set()
    config = json.loads(row["config_json"])
    outcome = config.get("outcome") or {}
    named = [*config.get("phone_columns", []), outcome.get("column"), outcome.get("called_column")]
    named += [config.get(key) for key in ("country_column", "first_name_column", "last_name_column", "name_column", "zip_column", "state_column")]
    return {name for name in named if name}


def _tidy_one(store: ProjectStore, dataset_id: str) -> tuple[int, int]:
    """Takes the empty rows and columns out of one list. Returns how many of each, (0, 0) when it was left as it was."""
    stored = store._connection.execute(
        "SELECT id, source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ? ORDER BY source_row_number", (dataset_id,)
    ).fetchall()
    if not stored:
        return 0, 0
    rows = [json.loads(row["raw_values_json"]) for row in stored]
    headers = list(dict.fromkeys(key for row in rows for key in row))
    ids_by_number = {row["source_row_number"]: row["id"] for row in stored}
    columns, kept_rows, kept_numbers = _without_empty(headers, rows, [row["source_row_number"] for row in stored])
    dropped_rows, dropped_columns = len(rows) - len(kept_rows), len(headers) - len(columns)
    if not kept_rows or not (dropped_rows or dropped_columns):
        # Nothing to take out, or a list with no data at all, which is left for the person to decide about.
        return 0, 0
    if _named_in_setup(store, dataset_id) & (set(headers) - set(columns)):
        return 0, 0
    kept_ids = {ids_by_number[number] for number in kept_numbers}
    with store._connection:
        if dropped_columns:
            store._connection.executemany(
                "UPDATE source_rows SET raw_values_json = ? WHERE id = ?",
                [(json.dumps(row, ensure_ascii=False, separators=(",", ":")), ids_by_number[number]) for row, number in zip(kept_rows, kept_numbers)],
            )
        if dropped_rows:
            store._connection.executemany("DELETE FROM source_rows WHERE id = ?", [(row["id"],) for row in stored if row["id"] not in kept_ids])
        store._connection.execute("UPDATE datasets SET row_count = ?, column_count = ? WHERE id = ?", (len(kept_rows), len(columns), dataset_id))
    return dropped_rows, dropped_columns


def tidy_project(store: ProjectStore, project_id: str) -> list[dict]:
    """Goes through the imported lists not looked at before. Returns what was taken out of which list."""
    seen = _checked(store)
    waiting = [
        row for row in store._connection.execute("SELECT id, name FROM datasets WHERE project_id = ? AND kind = 'import' ORDER BY created_at", (project_id,))
        if row["id"] not in seen
    ]
    report = []
    for dataset in waiting:
        if _in_use(store, dataset["id"]):
            continue
        dropped_rows, dropped_columns = _tidy_one(store, dataset["id"])
        if dropped_rows or dropped_columns:
            report.append({"dataset_id": dataset["id"], "name": dataset["name"], "dropped_empty_rows": dropped_rows, "dropped_empty_columns": dropped_columns})
    if waiting:
        mark_checked(store, [dataset["id"] for dataset in waiting])
    return report
