"""Turf CRM's Skip Tracing page: the exact command sequence it sends, from opening its workspace to saving a copy."""

from __future__ import annotations

import base64
import csv
import io
from pathlib import Path

import pytest

from turf_service.api import Service

from helpers import call, ok, wait

HEADER = ["Owner Name", "Phone", "Mobile", "Property Address", "City", "State", "Zip", "Last Call"]
ROWS = [
    ["Sarah Johnson", "(813) 274-6610", "", "1842 Palm Avenue", "Tampa", "FL", "33602", "Interested"],
    ["Michael Bennett", "(813) 274-6621", "(813) 274-6699", "620 Willow Street", "Tampa", "FL", "33603", "Wrong number"],
    ["Sarah Johnson", "(813) 274-6610", "", "1842 Palm Avenue", "Tampa", "FL", "33602", ""],
    ["Nora Diaz", "12345", "", "77 Bay Road", "Tampa", "FL", "33604", ""],
    ["Owen Price", "", "", "4 Oak Court", "Tampa", "FL", "33605", ""],
]


@pytest.fixture()
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Service:
    monkeypatch.setenv("TURF_APP_DATA", str(tmp_path / "appdata"))
    return Service()


def csv_content(rows: list[list[str]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(HEADER)
    writer.writerows(rows)
    return base64.b64encode(buffer.getvalue().encode("utf-8")).decode("ascii")


def run(svc: Service, command: str, **payload) -> dict:
    job = wait(svc, ok(svc, command, **payload)["job_id"])
    assert job["state"] == "completed", job
    return job["result"]


def test_workspace_opens_the_same_project_every_time(service: Service, tmp_path: Path):
    first = ok(service, "project.open_workspace", name="Turf CRM")
    assert Path(first["root_path"]) == (tmp_path / "appdata" / "Turf" / "workspaces" / "turfcrm").resolve()
    assert ok(service, "project.open_workspace", name="Turf CRM")["id"] == first["id"]
    # A new process finds the project the first one made.
    assert ok(Service(), "project.open_workspace", name="Turf CRM")["id"] == first["id"]


def test_workspace_names_cannot_leave_the_workspaces_folder(service: Service, tmp_path: Path):
    project = ok(service, "project.open_workspace", name="../../escape")
    assert Path(project["root_path"]).parent == (tmp_path / "appdata" / "Turf" / "workspaces").resolve()


def test_the_crm_sequence_checks_every_row_and_keeps_the_original(service: Service):
    ok(service, "project.open_workspace", name="crm")
    imported = run(service, "dataset.import_content", name="Tampa owners.csv", data=csv_content(ROWS))
    dataset = imported["dataset_id"]
    before = ok(service, "dataset.rows", dataset_id=dataset, limit=50)

    suggestion = ok(service, "skiptrace.suggest", dataset_id=dataset)
    config = suggestion["config"]
    assert config["phone_columns"] == ["Phone", "Mobile"]
    # The CRM sends its own mapping on top of the suggestion; the engine only accepts columns that exist.
    config["name_column"], config["address_column"], config["zip_column"] = "Owner Name", "Property Address", "Zip"
    config["outcome"] = {"column": "Last Call", "called_column": "Phone", "map": {"interested": ["reached"], "wrong number": ["wrong_number"]}}
    saved = ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)
    assert saved["outcome"]["map"]["wrong number"] == ["wrong_number"]

    events: list[dict] = []
    job_id = ok(service, "skiptrace.scan", dataset_id=dataset, config=saved)["job_id"]
    job = wait(service, job_id)
    assert job["state"] == "completed", job
    events = ok(service, "job.get", job_id=job_id, after_event_id=0).get("events") or []
    report = job["result"]["report"]
    counts = report["row_counts"]
    assert counts["all"] == len(ROWS)
    # Every row lands in exactly one group, which is what the CRM shows per lead.
    assert sum(counts[f"group_{group}"] for group in ("look", "blocked", "ready", "unknown", "no_phone")) == len(ROWS)
    assert counts["no_phone"] == 1 and counts["known_wrong"] >= 1 and counts["duplicates"] >= 2
    assert events, "the scan reports progress the CRM can show"

    review = ok(service, "skiptrace.review", job_id=job_id, filter="all", offset=0, limit=100)
    assert review["total"] == len(ROWS) and [row["row_number"] for row in review["rows"]] == list(range(2, len(ROWS) + 2)), "row numbers count the header as row 1"
    by_row = {row["row_number"]: row["raw"] for row in review["rows"]}
    assert by_row[2]["Best phone"] == "+18132746610"
    assert by_row[6]["Best phone"] == "" and by_row[6]["Owner Name"] == "Owen Price"
    assert "Phone (verdict)" in by_row[3] and by_row[5]["Phone"] == "12345", "original values travel with the verdict"

    applied = run(service, "skiptrace.apply", dataset_id=dataset, config=saved, name="Tampa owners · checked", scan_job_id=job_id)
    assert applied["rows"] == len(ROWS) and "Best phone" in applied["added_columns"]
    assert ok(service, "dataset.rows", dataset_id=dataset, limit=50) == before, "the source list is never changed"


def test_a_list_without_phone_columns_is_refused_with_a_reason(service: Service):
    ok(service, "project.open_workspace", name="crm")
    rows = [[name, "", "", address, "Tampa", "FL", "33602", ""] for name, address in (("A", "1 Main"), ("B", "2 Main"))]
    dataset = run(service, "dataset.import_content", name="No phones.csv", data=csv_content(rows))["dataset_id"]
    response = call(service, "skiptrace.save_settings", dataset_id=dataset, config={"phone_columns": []})
    assert not response["ok"] and "phone column" in response["error"]["message"]
