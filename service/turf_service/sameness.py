"""Whether a file being added holds the rows of a list that is already in the project.

Turf's own. The same list comes back under another file name, as a spreadsheet where it was a CSV, with its columns
renamed or in another order: none of that changes what its rows say. So a row is read as the values it holds,
whatever the columns are called and wherever they stand, and two lists are compared by the rows they share.

A list's rows are kept as a small sketch (the few thousand smallest of its rows' fingerprints, in the project's
settings), so adding a file never means reading every other list again. For a list of up to SKETCH rows the
answer is exact; for a longer one it is an estimate, good to a percent or two.
"""

from __future__ import annotations

import hashlib
import json
import re

from .storage import ProjectStore, utc_now

SKETCH = 4096
# A file is not added when this share of its rows is already in one list of the project.
SAME = 0.98
# Worth telling the person about, though the file is added.
OVERLAP = 0.2
_KEY = "sameness.sketch."
_SPACE = re.compile(r"\s+")
_WHOLE = re.compile(r"^(-?\d+)\.0+$")


def _value(value: object) -> str:
    text = _SPACE.sub(" ", str(value)).strip().casefold()
    whole = _WHOLE.match(text)  # a spreadsheet's 77008.0 is a CSV's 77008
    return whole.group(1) if whole else text


def row_key(raw: dict) -> int | None:
    """A row as the values it holds: not their columns' names, nor their order. None for a row that holds nothing."""
    values = sorted(text for text in (_value(value) for value in raw.values() if value is not None) if text)
    if not values:
        return None
    return int.from_bytes(hashlib.blake2b("\x1f".join(values).encode("utf-8"), digest_size=8).digest(), "big")


def sketch(rows) -> dict:
    keys = {key for key in (row_key(row) for row in rows) if key is not None}
    return {"rows": len(keys), "keys": sorted(keys)[:SKETCH]}


def shared(a: dict, b: dict) -> tuple[float, float]:
    """(the share of a's rows that are in b, the share of b's rows that are in a)."""
    if not a["rows"] or not b["rows"]:
        return 0.0, 0.0
    left, right = set(a["keys"]), set(b["keys"])
    if a["rows"] <= SKETCH and b["rows"] <= SKETCH:
        both = len(left & right)
        return both / a["rows"], both / b["rows"]
    # Both sketches hold the smallest fingerprints, so the smallest of the two together are a fair sample of all rows.
    sample = sorted(left | right)[:SKETCH]
    both = sum(1 for key in sample if key in left and key in right)
    jaccard = both / len(sample)
    in_both = jaccard * (a["rows"] + b["rows"]) / (1 + jaccard)
    return min(1.0, in_both / a["rows"]), min(1.0, in_both / b["rows"])


def _stored(store: ProjectStore, dataset_id: str) -> dict:
    """A list's sketch, made the first time it is asked for. A list's rows never change, so it is made once."""
    found = store._connection.execute("SELECT value_json FROM project_settings WHERE key = ?", (_KEY + dataset_id,)).fetchone()
    if found is not None:
        return json.loads(found["value_json"])
    rows = (json.loads(row["raw_values_json"]) for row in store._connection.execute("SELECT raw_values_json FROM source_rows WHERE dataset_id = ?", (dataset_id,)))
    made = sketch(rows)
    with store._connection:
        store._connection.execute(
            "INSERT INTO project_settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            (_KEY + dataset_id, json.dumps(made), utc_now()),
        )
    return made


def forget(store: ProjectStore, dataset_id: str) -> None:
    with store._connection:
        store._connection.execute("DELETE FROM project_settings WHERE key = ?", (_KEY + dataset_id,))


def same_file(store: ProjectStore, project_id: str, digest: str) -> dict | None:
    """The list this very file was added as before, byte for byte."""
    found = store._connection.execute(
        "SELECT id, name, row_count FROM datasets WHERE project_id = ? AND source_artifact_hash = ? AND kind IN ('import', 'scrape') ORDER BY created_at LIMIT 1", (project_id, digest)
    ).fetchone()
    return {"dataset_id": found["id"], "name": found["name"], "rows": found["row_count"], "share": 1.0, "how": "same_file"} if found else None


def compare(store: ProjectStore, project_id: str, dataset_id: str) -> tuple[dict | None, list[dict]]:
    """For a list just read in: (the list that already holds its rows, if one does; the lists it shares rows with).

    A checked copy is its list's rows with results added and a combined list is other lists' rows put together, so
    only lists that were themselves added or collected are compared with."""
    mine = _stored(store, dataset_id)
    others = store._connection.execute(
        "SELECT id, name, row_count FROM datasets WHERE project_id = ? AND id != ? AND kind IN ('import', 'scrape') ORDER BY created_at", (project_id, dataset_id)
    ).fetchall()
    already = None
    overlaps = []
    for other in others:
        in_other, of_other = shared(mine, _stored(store, other["id"]))
        entry = {"dataset_id": other["id"], "name": other["name"], "rows": other["row_count"], "share": round(in_other, 4), "of_other": round(of_other, 4)}
        if in_other >= SAME and (already is None or in_other > already["share"]):
            already = {**entry, "how": "same_rows" if of_other >= SAME else "all_inside"}
        elif in_other >= OVERLAP or of_other >= OVERLAP:
            overlaps.append(entry)
    return already, sorted(overlaps, key=lambda entry: -max(entry["share"], entry["of_other"]))
