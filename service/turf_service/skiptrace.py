"""Skip Tracing service: reads a dataset's phone columns, judges every number, and saves a checked copy.

The judging is in turf_matching.skiptrace; this module loads rows, keeps each dataset's setup, gathers what the
other datasets already say about a number, and writes results. A checked copy records the dataset it came from; the
original rows are never changed.
"""

from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path

from turf_matching import skiptrace as engine

from .cleaning import MAX_ROWS, _roles, _rows
from .datasets import _register_rows, confirm_mapping, latest_mapping
from .jobs import JobContext, JobKind, JobValidationError
from .storage import ProjectStore, utc_now
from .manual import list_marks

OUTPUT_SUFFIXES = ("verdict", "why", "E.164", "type", "quality", "permission")
BEST_COLUMNS = ("Best phone quality", "Best phone permission", "Best phone extension", "Best phone why", "Phone choices", "Phone evidence warnings", "Best phone", "Best phone verdict", "Best phone from")


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
        "address_column": column("address_column"), "business_column": column("business_column"), "call_date_column": column("call_date_column"),
        "evidence_age_days": int(config.get("evidence_age_days", 180)), "lookup_age_days": int(config.get("lookup_age_days", 30)),
        "signals": {code: bool((config.get("signals") or {}).get(code, engine.DEFAULT_SIGNALS[code])) for code in engine.COUNTABLE_SIGNALS},
    }
    if not 1 <= cleaned["evidence_age_days"] <= 3650 or not 1 <= cleaned["lookup_age_days"] <= 365:
        raise ValueError("Evidence age must be 1–3650 days and lookup age 1–365 days")
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
            if str(key):
                if any(kind in chosen for kind in ("wrong_number", "wrong_person", "disconnected")) and "reached" in chosen:
                    raise ValueError("A status cannot be both wrong number/wrong person/disconnected and reached a person")
                if "wrong_person" in chosen and not any(cleaned[key] for key in ("first_name_column", "last_name_column", "name_column")):
                    raise ValueError("Map name columns before using a wrong-person outcome")
                mapping[str(key)] = chosen
        cleaned["outcome"] = {"column": outcome["column"], "called_column": called, "map": mapping}
    return cleaned


def _samples(rows: list[dict], columns: list[str]) -> dict:
    samples = {column: [] for column in columns}
    for row in rows:
        for column in columns:
            value = str(row.get(column) if row.get(column) is not None else "").strip()
            if value and value not in samples[column] and len(samples[column]) < 3:
                samples[column].append(value[:160])
        if all(len(values) >= 3 for values in samples.values()):
            break
    return samples


def suggest(store: ProjectStore, dataset_id: str, region: str = "US") -> dict:
    _dataset(store, dataset_id)
    _, rows = _rows(store, dataset_id)
    columns = list(dict.fromkeys(column for row in rows for column in row))
    roles, _, confirmed = _roles(store, dataset_id, columns)
    found = engine.suggest(rows, roles, region)
    saved = get_settings(store, dataset_id)
    config = saved or found["config"]
    statuses = []
    outcome = (config.get("outcome") or {}).get("column") if saved is not None else ((config.get("outcome") or {}).get("column") or (found["outcome_candidates"][0]["column"] if found["outcome_candidates"] else None))
    if outcome:
        table = engine.status_table((row.get(outcome) for row in rows), config.get("region", region) != "US")
        saved_map = ((saved or {}).get("outcome") or {}).get("map") or {}
        statuses = [{**item, "outcomes": saved_map.get(item["key"], item["outcomes"]), "confirmed": item["key"] in saved_map} for item in table]
    return {
        "dataset_id": dataset_id, "rows": len(rows), "columns": columns, "config": config, "saved": saved is not None,
        "roles_confirmed": confirmed, "outcome_candidates": found["outcome_candidates"], "outcome_column": outcome, "statuses": statuses,
        "outcomes": [{"id": kind, "label": engine.OUTCOME_LABELS[kind]} for kind in engine.OUTCOMES],
        "column_samples": _samples(rows, columns),
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
    engine.collect(knowledge, rows, config, current["source_artifact_hash"], current["name"], context.checkpoint if context else None)
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
        engine.collect(knowledge, other_rows, json.loads(other["config_json"]), other["source_artifact_hash"], other["name"], context.checkpoint if context else None)
        used_names.append(other["name"])
    for number, entry in list_marks(store).items():
        source = f"{entry['source']} manual mark ({entry['at'][:10]})"
        if entry["mark"] == "wrong_number":
            knowledge.wrong[number].append(source)
        elif entry["mark"] == "do_not_call":
            knowledge.dnc[number].append((source, date.fromisoformat(entry["until"]) if entry["until"] else None))
        elif entry["mark"] == "interested":
            knowledge.reached[number].append(source)
        if entry["mark"] in ("wrong_number", "interested"):
            knowledge.events[number].append({"outcome": "reached" if entry["mark"] == "interested" else "wrong_number", "occurred_at": entry["at"], "person_key": None, "source": source})
        # Called alone is activity, not proof that a person answered.
    from .phone_evidence import evidence
    from .phone_lookup import latest
    for event in evidence(store):
        knowledge.events[event["number"]].append(event)
    knowledge.lookups = latest(store)
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
    return {"dataset_id": dataset["id"], "config": config, "name": str(params.get("name") or f"{dataset['name']} (phones checked)").strip()[:200], "scan_job_id": params.get("scan_job_id")}


def _evaluate(context: JobContext, keep_rows: bool) -> tuple[dict, dict, list[int], list[dict], list[str]]:
    store, params = context.store, context.params
    dataset = _dataset(store, params["dataset_id"])
    fingerprint = freshness(store, dataset["id"])["fingerprint"]
    context.stage("reading_file")
    numbers, rows = _rows(store, dataset["id"])
    if len(rows) > MAX_ROWS:
        raise ValueError(f"Skip Tracing handles up to {MAX_ROWS:,} rows per dataset")
    context.checkpoint()
    context.stage("gathering_outcomes")
    knowledge, other_names = _knowledge(store, dataset["project_id"], dataset, params["config"], rows, context)
    context.checkpoint()
    context.stage("checking_phones", {"rows": len(rows)})
    report = engine.evaluate(rows, numbers, params["config"], knowledge, dataset["name"], date.today(), keep_rows=keep_rows, checkpoint=context.checkpoint, progress=lambda done, total: context.stage("checking_phones", {"completed": done, "total": total}))
    if freshness(store, dataset["id"])["fingerprint"] != fingerprint:
        raise ValueError("The project evidence changed during the check. Check again before saving.")
    report["other_datasets_used"] = other_names
    report["fingerprint"] = fingerprint
    report["checked_at"] = utc_now()
    report["checked_date"] = date.today().isoformat()
    report["manual_evidence"] = list_marks(store)
    from .phone_evidence import evidence
    from .phone_lookup import latest
    report["phone_outcomes"] = evidence(store)
    report["phone_lookups"] = latest(store)
    if freshness(store, dataset["id"])["fingerprint"] != fingerprint:
        raise ValueError("The project evidence changed during the check. Check again before saving.")
    return dataset, report, numbers, rows, other_names


def freshness(store: ProjectStore, dataset_id: str) -> dict:
    dataset = dict(_dataset(store, dataset_id))
    sources = [dict(row) for row in store._connection.execute(
        "SELECT d.id, d.name, d.source_artifact_hash, s.config_json FROM datasets d JOIN skiptrace_settings s ON s.dataset_id=d.id WHERE d.project_id=? ORDER BY d.id", (dataset["project_id"],))]
    snapshot = {"date": date.today().isoformat(), "dataset": dataset, "sources": sources, "marks": list_marks(store),
                "engine": engine.SKIPTRACE_VERSION, "phone": engine.phone_rules.PHONE_VERSION, "metadata": engine.phone_rules.METADATA_VERSION}
    from .phone_evidence import evidence
    from .phone_lookup import latest
    snapshot.update({"phone_outcomes": evidence(store), "phone_lookups": latest(store)})
    digest = hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()
    return {"fingerprint": digest, "date": snapshot["date"]}


def _added_columns(config: dict) -> list[str]:
    return [f"{column} ({suffix})" for column in config["phone_columns"] for suffix in OUTPUT_SUFFIXES] + list(BEST_COLUMNS)


def _checked_row(row: dict, result: dict, config: dict) -> dict:
    out = dict(row)
    for column in config["phone_columns"]:
        data = result["columns"][column]
        out[f"{column} (verdict)"] = data["verdict"]
        out[f"{column} (why)"] = "; ".join(data["reasons"])
        out[f"{column} (E.164)"] = "; ".join(data["e164"])
        out[f"{column} (type)"] = "; ".join(data["type"])
        choices = [choice for choice in result.get("choices", []) if column in choice["columns"]]
        out[f"{column} (quality)"] = "; ".join(f"{choice['number'] or choice['raw']}: {choice['quality']}" for choice in choices)
        out[f"{column} (permission)"] = "; ".join(f"{choice['number'] or choice['raw']}: {choice['permission']}" for choice in choices)
    best = result["best"]
    out["Best phone"] = "; ".join(best[1]["e164"]) if best else ""
    out["Best phone verdict"] = best[1]["verdict"] if best else ""
    out["Best phone from"] = best[0] if best else ""
    choices = result.get("choices", [])
    preferred = next((choice for choice in choices if not choice["blocked"]), None)
    out["Phone choices"] = json.dumps(choices, ensure_ascii=False)
    out["Phone evidence warnings"] = "; ".join(dict.fromkeys(warning for choice in choices for warning in choice["warnings"]))
    assessed = preferred or (choices[0] if choices else None)
    out["Best phone quality"] = assessed["quality"] if assessed else ""
    out["Best phone permission"] = assessed["permission"] if assessed else ""
    out["Best phone extension"] = (preferred.get("extension") or "") if preferred else ""
    out["Best phone why"] = "; ".join(assessed["explanations"]) if assessed else ""
    if choices:
        out["Best phone"] = preferred["number"] if preferred else ""
        out["Best phone from"] = preferred["column"] if preferred else ""
        out["Best phone verdict"] = result["columns"][preferred["column"]]["verdict"] if preferred else ""
    return out


def _run_scan(context: JobContext) -> dict:
    _, report, numbers, rows, _ = _evaluate(context, keep_rows=True)
    results = report.pop("_row_results")
    records = []
    counts = {"all": len(rows), "callable": 0, "known_wrong": 0, "dnc": 0, "needs_review": 0, "no_phone": 0}
    counts.update({verdict: 0 for verdict in engine.VERDICTS})
    preview = []
    for index, (number, row, result) in enumerate(zip(numbers, rows, results)):
        if index % 250 == 0:
            context.checkpoint()
        out = _checked_row(row, result, context.params["config"])
        reasons = {reason["code"] for data in result["columns"].values() for _, _, items in data.get("judged", []) for reason in items}
        verdicts = [data["verdict"] for data in result["columns"].values() if data["verdict"]]
        verdict = out["Best phone verdict"] or ("wrong" if verdicts else "none")
        wrong, dnc, callable_ = "known_wrong" in reasons, "do_not_call" in reasons, bool(out["Best phone"])
        wrong = wrong or any(choice.get("known_wrong", False) for choice in result.get("choices", []))
        counts["callable"] += callable_
        counts["known_wrong"] += wrong
        counts["dnc"] += dnc
        needs_review = verdict in ("suspicious", "unverified") or "conflicting_outcomes" in reasons or bool(out["Phone evidence warnings"]) or any(choice["quality"] == "suspicious" for choice in result.get("choices", []))
        counts["needs_review"] += needs_review
        counts["no_phone"] += not verdicts
        if verdict in counts:
            counts[verdict] += 1
        records.append((context.job_id, number, json.dumps(out, ensure_ascii=False), verdict, wrong, dnc, callable_, needs_review))
        if len(preview) < 5:
            preview.append({"row_number": number, "raw": out})
    report["row_counts"] = counts
    report["preview"] = preview
    report["added_columns"] = _added_columns(context.params["config"])
    report["scan_job_id"] = context.job_id
    with context.store._connection:
        context.store._connection.executemany("INSERT INTO skiptrace_scan_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)", records)
        context.checkpoint()
    context.published = True
    return {"report": report}


def review(store: ProjectStore, job_id: str, filter_: str = "all", offset: int = 0, limit: int = 25, row_number: int | None = None) -> dict:
    job = store.job(job_id)
    if job is None or job["kind"] != "skiptrace_scan" or job["state"] != "completed":
        raise ValueError("Run a completed phone check before reviewing rows")
    filters = {"all": "1", "callable": "has_callable=1", "known_wrong": "known_wrong=1", "dnc": "do_not_call=1", "no_phone": "verdict='none'",
               "needs_review": "needs_review=1"}
    filters.update({verdict: f"verdict='{verdict}'" for verdict in engine.VERDICTS})
    if filter_ not in filters:
        raise ValueError("Unknown review filter")
    where = "job_id=? AND " + filters[filter_]
    args = [job_id]
    if row_number is not None:
        where += " AND row_number=?"
        args.append(int(row_number))
    total = store._connection.execute(f"SELECT COUNT(*) FROM skiptrace_scan_rows WHERE {where}", args).fetchone()[0]
    found = store._connection.execute(f"SELECT row_number, raw_json FROM skiptrace_scan_rows WHERE {where} ORDER BY row_number LIMIT ? OFFSET ?", [*args, max(1, min(limit, 100)), max(0, offset)])
    return {"total": total, "rows": [{"row_number": r["row_number"], "raw": json.loads(r["raw_json"])} for r in found]}


def _run_apply(context: JobContext) -> dict:
    store, params = context.store, context.params
    scan_id = params.get("scan_job_id")
    if scan_id:
        scan = store.job(scan_id)
        if scan is None or scan["kind"] != "skiptrace_scan" or scan["state"] != "completed":
            raise ValueError("Check phone numbers again before saving")
        scan_params = json.loads(scan["params_json"])
        report = json.loads(scan["result_json"])["report"]
        if scan_params["dataset_id"] != params["dataset_id"] or scan_params["config"] != params["config"]:
            raise ValueError("The setup changed. Check again before saving.")
        dataset = _dataset(store, params["dataset_id"])
        records = list(store._connection.execute("SELECT row_number, raw_json FROM skiptrace_scan_rows WHERE job_id=? ORDER BY row_number", (scan_id,)))
        numbers = [r["row_number"] for r in records]
        checked_rows = [json.loads(r["raw_json"]) for r in records]
        if len(checked_rows) != report["rows"]:
            raise ValueError("The reviewed rows are unavailable. Check again before saving.")
        others = report["other_datasets_used"]
    else:
        dataset, report, numbers, rows, others = _evaluate(context, keep_rows=True)
        checked_rows = [_checked_row(row, result, params["config"]) for row, result in zip(rows, report.pop("_row_results"))]
    context.stage("saving_checked_copy", {"rows": len(checked_rows)})
    context.checkpoint()
    added = _added_columns(params["config"])
    columns = list(dict.fromkeys(column for row in checked_rows for column in row if column not in added)) + added
    from .downloads import archive_csv, original_file
    derivation = {
        "skiptrace_version": engine.SKIPTRACE_VERSION, "phone_version": report["phone_version"], "metadata_version": report["metadata_version"],
        "config": params["config"], "summary": {"rows": report["rows"], "values": report["values"], "verdicts": report["verdicts"]}, "other_datasets_used": others,
        "checked_at": report["checked_at"], "fingerprint": report["fingerprint"], "manual_evidence": report["manual_evidence"], "scan_job_id": scan_id,
        "original_file": original_file(store, dataset["id"]),
        "phone_outcomes": report.get("phone_outcomes", []), "phone_lookups": report.get("phone_lookups", {}),
        "checked_file": archive_csv(store, columns, checked_rows),
    }
    payload = json.dumps({"derivation": derivation, "rows": checked_rows}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    # Serialize publication against evidence edits. A cancelled save never leaves a partial list.
    store._connection.execute("BEGIN IMMEDIATE")
    try:
        if freshness(store, dataset["id"])["fingerprint"] != report["fingerprint"]:
            raise ValueError("The check is out of date: the date or project evidence changed. Check again before saving.")
        context.checkpoint()
        created = _register_rows(store, dataset["project_id"], Path(f"{params['name']}.json"), payload, columns, checked_rows, params["name"], kind="checked", row_numbers=numbers, commit=False)
        store._connection.execute("UPDATE datasets SET parent_dataset_id = ?, derivation_json = ? WHERE id = ?", (dataset["id"], json.dumps(derivation, sort_keys=True), created.dataset_id))
        mapping = latest_mapping(store, dataset["id"])
        if mapping is not None:
            confirm_mapping(store, created.dataset_id, json.loads(mapping["mapping_json"]), mapping["entity_type"], json.loads(mapping["export_exclude_json"] or "[]"), commit=False)
        context.checkpoint()
        store._connection.commit()
        context.published = True
    except BaseException:
        store._connection.rollback()
        raise
    return {"dataset_id": created.dataset_id, "rows": len(checked_rows), "added_columns": added, "verdicts": report["verdicts"], "rows_with_callable_number": report["rows_with_callable_number"], "checked_at": report["checked_at"]}


SCAN_JOB = JobKind(run=_run_scan, validate=_validate)
APPLY_JOB = JobKind(run=_run_apply, validate=_validate)
