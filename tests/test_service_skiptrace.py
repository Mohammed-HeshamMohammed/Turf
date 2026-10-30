"""Skip Tracing through the command API: suggest a setup, save it, scan, and save a checked copy."""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from turf_service.api import Service

from helpers import call, ok, wait

HEADER = ["First Name", "Last Name", "Phone", "Alt. Phone", "Zip", "State", "Status"]


@pytest.fixture()
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Service:
    monkeypatch.setenv("CALLERWHALE_APP_DATA", str(tmp_path / "appdata"))
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Fixture")
    return svc


def make_dataset(svc: Service, tmp_path: Path, name: str, rows: list[list[str]]) -> str:
    path = tmp_path / f"{name}.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(HEADER)
        writer.writerows(rows)
    job = wait(svc, ok(svc, "dataset.import", path=str(path), name=name)["job_id"])
    assert job["state"] == "completed", job
    return job["result"]["dataset_id"]


def run(svc: Service, command: str, **payload) -> dict:
    job = wait(svc, ok(svc, command, **payload)["job_id"])
    assert job["state"] == "completed", job
    return job["result"]


FILE_A = [
    ["Ana", "Lopez", "(713) 555-3142", "(713) 555-4455", "77009", "TX", "Not yet reached"],
    ["Ben", "Ortiz", "(245) 749-3151", "", "77018", "TX", "Not yet reached"],
    ["Cy", "Young", "(713) 555-6677", "", "77019", "TX", "DNC: wrong number"],
    ["Di", "Park", "(713) 555-8899", "", "77020", "TX", "DNC until 12/01/2026:Not interested"],
    ["Ed", "Shaw", "(713) 555-2211", "", "77021", "TX", "Interested"],
]
FILE_B = [
    ["Fay", "Bell", "(713) 555-6677", "", "77030", "TX", "Not yet reached"],       # Cy's number, marked wrong in file A
    ["Gus", "Hill", "(713) 555-8899", "", "77031", "TX", "Not yet reached"],       # Di's number, do-not-call in file A
    ["Hal", "Moss", "(713) 555-9090", "", "77032", "TX", "Not yet reached"],
]


def test_the_setup_is_suggested_with_the_status_meanings(service: Service, tmp_path: Path):
    dataset = make_dataset(service, tmp_path, "File A", FILE_A)
    suggestion = ok(service, "skiptrace.suggest", dataset_id=dataset)
    config = suggestion["config"]
    assert config["phone_columns"] == ["Phone", "Alt. Phone"] and config["state_column"] == "State" and config["zip_column"] == "Zip"
    assert suggestion["outcome_column"] == "Status" and not suggestion["saved"]
    meanings = {item["key"]: item["outcomes"] for item in suggestion["statuses"]}
    assert meanings["dnc: wrong number"] == ["wrong_number"] and meanings["not yet reached"] == [] and meanings["interested"] == ["reached"]
    assert [item["id"] for item in suggestion["outcomes"]] == ["wrong_number", "do_not_call", "reached", "wrong_person", "disconnected", "voicemail", "no_answer"]
    assert ok(service, "skiptrace.statuses", dataset_id=dataset, column="Status")[0]["count"] >= 1


def confirmed(service: Service, dataset: str) -> dict:
    suggestion = ok(service, "skiptrace.suggest", dataset_id=dataset)
    config = suggestion["config"]
    config["outcome"] = {"column": "Status", "called_column": "Phone", "map": {item["key"]: item["outcomes"] for item in suggestion["statuses"]}}
    return ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)


def test_a_bad_setup_is_refused_with_a_clear_message(service: Service, tmp_path: Path):
    dataset = make_dataset(service, tmp_path, "File A", FILE_A)
    for config, message in [
        ({"phone_columns": []}, "at least one phone column"), ({"phone_columns": ["Nope"]}, "Unknown column: Nope"),
        ({"phone_columns": ["Phone"], "region": "ZZ"}, "not a country"),
        ({"phone_columns": ["Phone"], "outcome": {"column": "Nope"}}, "status column"),
        ({"phone_columns": ["Phone"], "outcome": {"column": "Status", "called_column": "Alt. Phone"}}, "one of the phone columns"),
    ]:
        error = call(service, "skiptrace.save_settings", dataset_id=dataset, config=config)["error"]["message"]
        assert message in error, (config, error)
    refused = call(service, "skiptrace.scan", dataset_id=dataset, config={"phone_columns": ["Nope"]})
    assert not refused["ok"] and "Unknown column" in refused["error"]["message"]


def test_a_scan_reports_the_verdicts_the_columns_and_the_outcomes(service: Service, tmp_path: Path):
    dataset = make_dataset(service, tmp_path, "File A", FILE_A)
    config = confirmed(service, dataset)
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert report["rows"] == 5 and report["values"] == 6
    assert report["verdicts"]["wrong"] == 3 and report["verdicts"]["corroborated"] == 1 and report["verdicts"]["unverified"] == 2
    reasons = {item["code"]: item["count"] for item in report["reasons"]}
    assert reasons["format_not_in_plan"] == 1 and reasons["known_wrong"] == 1 and reasons["do_not_call"] == 1
    assert [c["column"] for c in report["columns"]] == ["Phone", "Alt. Phone"] and report["columns"][1]["filled"] == 1
    assert report["outcomes"]["available"] and report["outcomes"]["known_wrong_numbers"] == 1
    assert report["metadata_version"] and report["other_datasets_used"] == []


def test_outcomes_in_one_file_warn_about_numbers_in_another(service: Service, tmp_path: Path):
    file_a = make_dataset(service, tmp_path, "File A", FILE_A)
    file_b = make_dataset(service, tmp_path, "File B", FILE_B)
    confirmed(service, file_a)                       # File A's setup is saved, so its outcomes are known
    config_b = confirmed(service, file_b)
    report = run(service, "skiptrace.scan", dataset_id=file_b, config=config_b)["report"]
    assert report["other_datasets_used"] == ["File A"]
    assert report["verdicts"]["wrong"] == 2 and report["verdicts"]["unverified"] == 1
    assert report["outcomes"]["carried_rows"] == 2
    texts = [example["text"] for item in report["reasons"] for example in item["examples"]]
    assert any("File A" in text and "wrong number" in text for text in texts) and any("do-not-call list in File A" in text for text in texts)


def test_a_checked_copy_adds_the_verdict_columns_and_leaves_the_original_alone(service: Service, tmp_path: Path):
    file_a = make_dataset(service, tmp_path, "File A", FILE_A)
    config = confirmed(service, file_a)
    before = ok(service, "dataset.rows", dataset_id=file_a)
    result = run(service, "skiptrace.apply", dataset_id=file_a, config=config, name="File A checked")
    assert result["rows"] == 5 and result["rows_with_callable_number"] == 2
    assert result["added_columns"][:4] == ["Phone (verdict)", "Phone (why)", "Phone (E.164)", "Phone (type)"] and result["added_columns"][-7:] == ["Best phone", "Best phone verdict", "Best phone from", "Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows"]

    listing = {d["id"]: d for d in ok(service, "dataset.list")}
    checked = listing[result["dataset_id"]]
    assert checked["kind"] == "checked" and checked["name"] == "File A checked" and checked["row_count"] == 5
    rows = {r["row_number"]: r["raw"] for r in ok(service, "dataset.rows", dataset_id=result["dataset_id"])}
    ana, ben, ed = rows[2], rows[3], rows[6]
    assert (ana["Phone (verdict)"], ana["Phone (E.164)"], ana["Phone (type)"]) == ("unverified", "+17135553142", "landline or mobile")
    assert ana["Best phone"] == "+17135553142" and ana["Best phone from"] == "Phone"
    assert ben["Phone (verdict)"] == "wrong" and "Area code 245" in ben["Phone (why)"] and ben["Best phone"] == ""
    assert ed["Phone (verdict)"] == "corroborated" and ed["Best phone verdict"] == "corroborated"
    assert ok(service, "dataset.rows", dataset_id=file_a) == before, "the original rows are untouched"


def test_deleting_a_dataset_removes_its_saved_setup(service: Service, tmp_path: Path):
    dataset = make_dataset(service, tmp_path, "File A", FILE_A)
    confirmed(service, dataset)
    assert ok(service, "skiptrace.suggest", dataset_id=dataset)["saved"] is True
    ok(service, "dataset.delete", dataset_id=dataset)
    assert service.store._connection.execute("SELECT COUNT(*) FROM skiptrace_settings").fetchone()[0] == 0
