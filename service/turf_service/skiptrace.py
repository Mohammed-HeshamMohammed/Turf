"""Skip Tracing service: reads a dataset's phone columns, judges every number, and saves a checked copy.

The judging is in turf_matching.skiptrace; this module loads rows, keeps each dataset's setup, gathers what the
other datasets already say about a number, and writes results. A checked copy records the dataset it came from; the
original rows are never changed.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from turf_matching import skiptrace as engine

from .cleaning import MAX_ROWS, _roles, _rows
from .datasets import _register_rows, confirm_mapping, latest_mapping
from .jobs import JobContext, JobKind, JobValidationError
from .storage import ProjectStore, utc_now

OUTPUT_SUFFIXES = ("verdict", "why", "E.164", "type")
BEST_COLUMNS = ("Best phone", "Best phone verdict", "Best phone from")


def _dataset(store: ProjectStore, dataset_id: object):
    row = store._connection.execute("SELECT id, name, project_id, source_artifact_hash FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    if row is None:
        raise ValueError("Dataset not found")
    return row


def get_settings(store: ProjectStore, dataset_id: str) -> dict | None:
    row = store._connection.execute("SELECT config_json FROM skiptrace_settings WHERE dataset_id = ?", (dataset_id,)).fetchone()
    return json.loads(row["config_json"]) if row else None


def clean_config(config: object, columns: list[str]) -> dict:
    """Checks a setup from the UI against the dataset's columns and keeps only what the engine reads."""
    if not isinstance(config, dict):
        raise ValueError("A setup is required")

    def column(key: str, required: bool = False) -> str | None:
        value = config.get(key)
        if value in (None, ""):
            if required:
                raise ValueError("Choose at least one phone column")
            return None
        if value not in columns:
            raise ValueError(f"Unknown column: {value}")
        return str(value)

    phones = [str(item) for item in config.get("phone_columns") or []]
    if not phones:
        raise ValueError("Choose at least one phone column")
    unknown = [item for item in phones if item not in columns]
    if unknown:
        raise ValueError(f"Unknown column: {unknown[0]}")
    region = str(config.get("region") or "US").upper()
    if region not in engine.phone_rules.phonenumbers.SUPPORTED_REGIONS:
        raise ValueError(f"{region} is not a country libphonenumber knows")
    cleaned = {
        "phone_columns": list(dict.fromkeys(phones)), "region": region, "country_column": column("country_column"),
        "first_name_column": column("first_name_column"), "last_name_column": column("last_name_column"), "name_column": column("name_column"),
        "zip_column": column("zip_column"), "state_column": column("state_column"), "outcome": None,
        "signals": {code: bool((config.get("signals") or {}).get(code, engine.DEFAULT_SIGNALS[code])) for code in engine.COUNTABLE_SIGNALS},
    }
    outcome = config.get("outcome")
    if outcome:
        if not isinstance(outcome, dict) or outcome.get("column") not in columns:
            raise ValueError("Choose the status column from this dataset")
        called = outcome.get("called_column") or phones[0]
        if called not in phones:
            raise ValueError("The called number must be one of the phone columns")
        mapping = {}
        for key, kinds in (outcome.get("map") or {}).items():
            chosen = [kind for kind in kinds if kind in engine.OUTCOMES] if isinstance(kinds, list) else []
            if chosen:
                mapping[str(key)] = chosen
        cleaned["outcome"] = {"column": outcome["column"], "called_column": called, "map": mapping}
    return cleaned


def suggest(store: ProjectStore, dataset_id: str, region: str = "US") -> dict:
    _dataset(store, dataset_id)
    _, rows = _rows(store, dataset_id)
    columns = list(dict.fromkeys(column for row in rows for column in row))
    roles, _, confirmed = _roles(store, dataset_id, columns)
    found = engine.suggest(rows, roles, region)
    saved = get_settings(store, dataset_id)
    config = saved or found["config"]
    statuses = []
    outcome = (config.get("outcome") or {}).get("column") or (found["outcome_candidates"][0]["column"] if len(found["outcome_candidates"]) else None)
    if outcome:
        table = engine.status_table((row.get(outcome) for row in rows), config.get("region", region) != "US")
        saved_map = ((saved or {}).get("outcome") or {}).get("map") or {}
        statuses = [{**item, "outcomes": saved_map.get(item["key"], item["outcomes"]) if saved else item["outcomes"]} for item in table]
    return {
        "dataset_id": dataset_id, "rows": len(rows), "columns": columns, "config": config, "saved": saved is not None,
        "roles_confirmed": confirmed, "outcome_candidates": found["outcome_candidates"], "outcome_column": outcome, "statuses": statuses,
        "outcomes": [{"id": kind, "label": engine.OUTCOME_LABELS[kind]} for kind in engine.OUTCOMES],
        "signals": [{"code": code, "label": engine.SIGNALS[code], "measured_only": code not in engine.COUNTABLE_SIGNALS} for code in engine.SIGNALS],
    }


def statuses_for(store: ProjectStore, dataset_id: str, column: str, region: str = "US") -> list[dict]:
    """The status table for another status column, when the person picks one."""
    _dataset(store, dataset_id)
    _, rows = _rows(store, dataset_id)
    if not any(column in row for row in rows[:50]):
        raise ValueError(f"Unknown column: {column}")
    return engine.status_table((row.get(column) for row in rows), region.upper() != "US")


def save_settings(store: ProjectStore, dataset_id: str, config: object) -> dict:
    _dataset(store, dataset_id)
    _, rows = _rows(store, dataset_id)
    columns = list(dict.fromkeys(column for row in rows for column in row))
    cleaned = clean_config(config, columns)
    with store._connection:
        store._connection.execute(
            "INSERT INTO skiptrace_settings(dataset_id, config_json, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(dataset_id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at",
            (dataset_id, json.dumps(cleaned, sort_keys=True), utc_now()),
        )
    return cleaned


def _knowledge(store: ProjectStore, project_id: str, current: dict, config: dict, rows: list[dict], context: JobContext | None = None) -> tuple[engine.Knowledge, list[str]]:
    """What every dataset in the project already says about a number. Files with identical content count once."""
    knowledge = engine.Knowledge()
    engine.collect(knowledge, rows, config, current["source_artifact_hash"], current["name"])
    used_hashes = {current["source_artifact_hash"]}
    used_names: list[str] = []
    others = store._connection.execute(
        "SELECT d.id, d.name, d.source_artifact_hash, s.config_json FROM datasets d JOIN skiptrace_settings s ON s.dataset_id = d.id "
        "WHERE d.project_id = ? AND d.id != ? ORDER BY d.created_at",
        (project_id, current["id"]),
    ).fetchall()
    for other in others:
        if other["source_artifact_hash"] in used_hashes:
            continue
        if context is not None:
            context.checkpoint()
        used_hashes.add(other["source_artifact_hash"])
        _, other_rows = _rows(store, other["id"])
        engine.collect(knowledge, other_rows, json.loads(other["config_json"]), other["source_artifact_hash"], other["name"])
        used_names.append(other["name"])
    return knowledge, used_names


def _validate(store: ProjectStore, params: dict) -> dict:
    dataset = store._connection.execute("SELECT id, name FROM datasets WHERE id = ?", (params.get("dataset_id"),)).fetchone()
    if dataset is None:
        raise JobValidationError("Dataset not found")
    columns = set()
    for row in store._connection.execute("SELECT raw_values_json FROM source_rows WHERE dataset_id = ? LIMIT 200", (dataset["id"],)):
        columns.update(json.loads(row["raw_values_json"]))
    try:
        config = clean_config(params.get("config"), sorted(columns))
    except ValueError as error:
        raise JobValidationError(str(error)) from error
    return {"dataset_id": dataset["id"], "config": config, "name": str(params.get("name") or f"{dataset['name']} (phones checked)").strip()[:200]}


def _evaluate(context: JobContext, keep_rows: bool) -> tuple[dict, dict, list[int], list[dict], list[str]]:
    store, params = context.store, context.params
    dataset = _dataset(store, params["dataset_id"])
    context.stage("reading_file")
    numbers, rows = _rows(store, dataset["id"])
    if len(rows) > MAX_ROWS:
        raise ValueError(f"Skip Tracing handles up to {MAX_ROWS:,} rows per dataset")
    context.checkpoint()
    context.stage("gathering_outcomes")
    knowledge, other_names = _knowledge(store, dataset["project_id"], dataset, params["config"], rows, context)
    context.checkpoint()
    context.stage("checking_phones", {"rows": len(rows)})
    report = engine.evaluate(rows, numbers, params["config"], knowledge, dataset["name"], date.today(), keep_rows=keep_rows)
    report["other_datasets_used"] = other_names
    return dataset, report, numbers, rows, other_names


def _run_scan(context: JobContext) -> dict:
    _, report, _, _, _ = _evaluate(context, keep_rows=False)
    return {"report": report}


def _run_apply(context: JobContext) -> dict:
    store, params = context.store, context.params
    dataset, report, numbers, rows, others = _evaluate(context, keep_rows=True)
    results = report.pop("_row_results")
    context.stage("saving_checked_copy", {"rows": len(rows)})
    columns = list(dict.fromkeys(column for row in rows for column in row))
    added = []
    for column in params["config"]["phone_columns"]:
        added += [f"{column} ({suffix})" for suffix in OUTPUT_SUFFIXES]
    added += list(BEST_COLUMNS)
    checked_rows = []
    for row, result in zip(rows, results):
        out = dict(row)
        for column in params["config"]["phone_columns"]:
            data = result["columns"][column]
            out[f"{column} (verdict)"] = data["verdict"]
            out[f"{column} (why)"] = "; ".join(data["reasons"])
            out[f"{column} (E.164)"] = "; ".join(data["e164"])
            out[f"{column} (type)"] = "; ".join(data["type"])
        best = result["best"]
        out["Best phone"] = "; ".join(best[1]["e164"]) if best else ""
        out["Best phone verdict"] = best[1]["verdict"] if best else ""
        out["Best phone from"] = best[0] if best else ""
        checked_rows.append(out)
    derivation = {
        "skiptrace_version": engine.SKIPTRACE_VERSION, "phone_version": report["phone_version"], "metadata_version": report["metadata_version"],
        "config": params["config"], "summary": {"rows": report["rows"], "values": report["values"], "verdicts": report["verdicts"]}, "other_datasets_used": others,
    }
    payload = json.dumps({"derivation": derivation, "rows": checked_rows}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    context.checkpoint()
    project_id = store.job(context.job_id)["project_id"]
    created = _register_rows(
        store, project_id, Path(f"{params['name']}.json"), payload, columns + added, checked_rows, params["name"], kind="checked", row_numbers=numbers,
    )
    store._connection.execute("UPDATE datasets SET parent_dataset_id = ?, derivation_json = ? WHERE id = ?", (dataset["id"], json.dumps(derivation, sort_keys=True), created.dataset_id))
    store._connection.commit()
    mapping = latest_mapping(store, dataset["id"])
    if mapping is not None:
        confirm_mapping(store, created.dataset_id, json.loads(mapping["mapping_json"]), mapping["entity_type"], json.loads(mapping["export_exclude_json"] or "[]"))
    return {"dataset_id": created.dataset_id, "rows": len(checked_rows), "added_columns": added, "verdicts": report["verdicts"], "rows_with_callable_number": report["rows_with_callable_number"]}


SCAN_JOB = JobKind(run=_run_scan, validate=_validate)
APPLY_JOB = JobKind(run=_run_apply, validate=_validate)
