"""Reading one dataset's rows and what its columns are, for Skip Tracing.

Turf: this is what is left of DataForge's clean-up module. Turf has no clean-up screen, so the scan and the job that
wrote a cleaned copy are not here; Skip Tracing uses the two readers below."""

from __future__ import annotations

import json

from .datasets import latest_mapping, propose_field_mappings
from .storage import ProjectStore

MAX_ROWS = 500_000


def _rows(store: ProjectStore, dataset_id: str) -> tuple[list[int], list[dict[str, object]]]:
    found = store._connection.execute(
        "SELECT source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ? ORDER BY source_row_number LIMIT ?", (dataset_id, MAX_ROWS + 1)
    ).fetchall()
    if len(found) > MAX_ROWS:
        raise ValueError(f"Cleanup handles up to {MAX_ROWS:,} rows per dataset")
    return [row["source_row_number"] for row in found], [json.loads(row["raw_values_json"]) for row in found]


def _roles(store: ProjectStore, dataset_id: str, columns: list[str]) -> tuple[dict[str, str], bool, bool]:
    """Column roles from the confirmed mapping, or proposed from the headers; whether the records are people;
    and whether the roles came from a confirmed mapping."""
    mapping = latest_mapping(store, dataset_id)
    if mapping is not None:
        roles = json.loads(mapping["mapping_json"])
        return roles, (mapping["entity_type"] or "person") == "person" or any(r in ("first_name", "last_name") for r in roles.values()), True
    proposals = {p.source_field: p.role for p in propose_field_mappings(columns)}
    return proposals, True, False
