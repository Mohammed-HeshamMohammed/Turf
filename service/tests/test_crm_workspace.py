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
    monkeypatch.setenv("CALLERWHALE_APP_DATA", str(tmp_path / "appdata"))
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


COUNTY = ["Id", "Address", "City", "State", "Zip", "Owner 1 First Name", "Owner 1 Last Name", "Owner Mailing Address"]


def county_csv(rows: list[list[str]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(COUNTY)
    writer.writerows(rows)
    return base64.b64encode(buffer.getvalue().encode("utf-8")).decode("ascii")


def test_a_list_without_phones_still_finds_repeated_leads(service: Service):
    ok(service, "project.open_workspace", name="crm")
    rows = [
        ["1", "840 W 124TH ST", "LOS ANGELES", "CA", "90044", "VIRGINIA", "FRIZ", "721 W EL SEGUNDO BLVD"],
        ["2", "840 W 124th Street", "Los Angeles", "CA", "90044", "Virginia", "Friz", "721 W EL SEGUNDO BLVD"],
        ["3", "12 OAK AVE", "LOS ANGELES", "CA", "90045", "VIRGINIA", "FRIZ", "721 W EL SEGUNDO BLVD"],
        ["4", "9 PINE RD", "GARDENA", "CA", "90247", "SAM", "HILL", "9 PINE RD"],
    ]
    dataset = run(service, "dataset.import_content", name="County.csv", data=county_csv(rows))["dataset_id"]
    config = {"first_name_column": "Owner 1 First Name", "last_name_column": "Owner 1 Last Name", "address_column": "Address", "city_column": "City",
              "state_column": "State", "zip_column": "Zip", "mailing_address_column": "Owner Mailing Address"}
    found = run(service, "skiptrace.repeats", dataset_id=dataset, config=config)
    by_row = {item["row_number"]: item for item in found["results"]}
    assert found["rows"] == 4 and len(by_row) == 4
    # Rows 2 and 3 are one lead written twice: one is kept, the other is its repeat.
    statuses = sorted(by_row[n]["status"] for n in (2, 3))
    assert statuses[1] == "Keep" and (statuses[0].startswith("Duplicate") or statuses[0].startswith("Possible")), by_row
    assert not by_row[4]["status"].startswith(("Duplicate", "Possible")), "the same owner's other property is its own lead"
    assert not by_row[5]["status"], "a different owner and property is not a repeat"


def test_repeats_needs_a_name_or_address_and_known_columns(service: Service):
    ok(service, "project.open_workspace", name="crm")
    dataset = run(service, "dataset.import_content", name="County.csv", data=county_csv([["1", "1 Main", "X", "CA", "1", "A", "B", "C"]]))["dataset_id"]
    assert not call(service, "skiptrace.repeats", dataset_id=dataset, config={})["ok"]
    assert not call(service, "skiptrace.repeats", dataset_id=dataset, config={"address_column": "Nope"})["ok"]


def test_another_parcel_or_house_number_is_never_a_repeat_even_with_the_same_owner(service: Service):
    ok(service, "project.open_workspace", name="crm")
    header = ["Id", "Address", "City", "State", "Zip", "Owner 1 First Name", "Owner 1 Last Name", "Owner Mailing Address", "APN"]
    rows = [
        ["1", "826 W 58TH PL", "LOS ANGELES", "CA", "90044", "ANGELES", "LOS", "200 N SPRING ST", "6004-003-906"],
        ["2", "826 W 59TH PL", "LOS ANGELES", "CA", "90044", "ANGELES", "LOS", "200 N SPRING ST", "6004-008-902"],
        ["3", "917 W 69TH ST", "LOS ANGELES", "CA", "90044", "ANGELES", "LOS", "200 N SPRING ST", "6013-007-902"],
        ["4", "12 OAK AVE APT 2", "LOS ANGELES", "CA", "90045", "MONA", "ADEL", "5 ELM", ""],
        ["5", "12 OAK AVE APT 3", "LOS ANGELES", "CA", "90045", "MONA", "ADEL", "5 ELM", ""],
        ["6", "840 W 124TH ST", "LOS ANGELES", "CA", "90044", "VIRGINIA", "FRIZ", "721 W EL SEGUNDO", "6117-016-011"],
        ["7", "840 W 124th Street", "Los Angeles", "CA", "90044", "Virginia", "Friz", "721 W EL SEGUNDO", "6117-016-011"],
    ]
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(header)
    writer.writerows(rows)
    data = base64.b64encode(buffer.getvalue().encode()).decode()
    dataset = run(service, "dataset.import_content", name="Parcels.csv", data=data)["dataset_id"]
    config = {"first_name_column": "Owner 1 First Name", "last_name_column": "Owner 1 Last Name", "address_column": "Address", "city_column": "City",
              "state_column": "State", "zip_column": "Zip", "mailing_address_column": "Owner Mailing Address", "parcel_column": "APN"}
    found = run(service, "skiptrace.repeats", dataset_id=dataset, config=config)
    by_row = {item["row_number"]: item for item in found["results"]}
    for number in (2, 3, 4, 5, 6):
        assert not by_row[number]["status"], (number, by_row[number])
    assert by_row[3]["same_owner"] and by_row[2]["same_owner"], "the same owner's other parcels are still linked"
    statuses = sorted(by_row[n]["status"] for n in (7, 8))
    assert statuses[1] == "Keep" and statuses[0].startswith(("Duplicate", "Possible")), "one parcel written twice is still a repeat"
    assert found["repeats"] == 1 and found["same_owner"] >= 3


def test_each_property_is_told_its_owner_their_properties_and_a_score(service: Service):
    ok(service, "project.open_workspace", name="crm")
    header = ["Address", "State", "Zip", "Owner 1 First Name", "Owner 1 Last Name", "Owner Mailing Address", "Owner Mailing State",
              "Owner Mailing Zip", "Owner Type", "Vacant?", "Ownership Length (Months)"]
    rows = [
        ["10 A ST", "CA", "90001", "GEORGE", "WILLIAMS", "8005 WEST BLVD", "CA", "90305", "INDIVIDUAL,INVESTOR", "1", "221"],
        ["22 B ST", "CA", "91770", "GEORGE", "WILLIAMS", "8005 WEST BLVD", "CA", "90305", "INDIVIDUAL,INVESTOR", "", "221"],
        ["5 C ST", "CA", "90002", "ANNA", "LEE", "5 C ST", "CA", "90002", "INDIVIDUAL", "", "320"],
        ["7 D ST", "CA", "90003", "", "LANCASTER HOUSING AUTHORITY", "44933 FERN AVE", "CA", "93534", "GOVERNMENT,INDIVIDUAL", "", ""],
        ["9 E ST", "CA", "90004", "JOHN", "SKALICKY", "3327 COUNTRY CLUB DR", "TX", "75001", "INDIVIDUAL", "", "1508"],
    ]
    buffer = io.StringIO()
    csv.writer(buffer).writerows([header, *rows])
    dataset = run(service, "dataset.import_content", name="Owners.csv", data=base64.b64encode(buffer.getvalue().encode()).decode())["dataset_id"]
    config = {"first_name_column": "Owner 1 First Name", "last_name_column": "Owner 1 Last Name", "address_column": "Address", "state_column": "State",
              "zip_column": "Zip", "mailing_address_column": "Owner Mailing Address", "mailing_state_column": "Owner Mailing State",
              "mailing_zip_column": "Owner Mailing Zip", "owner_type_column": "Owner Type", "vacant_column": "Vacant?",
              "ownership_months_column": "Ownership Length (Months)", "owner_occupied_column": "Owner Occupied"}
    found = run(service, "skiptrace.repeats", dataset_id=dataset, config=config)
    by_row = {item["row_number"]: item for item in found["results"]}
    # One owner with properties in two ZIP codes: one owner, two properties, both addresses listed.
    assert by_row[2]["owner"] == by_row[3]["owner"] and by_row[2]["properties"] == 2
    assert by_row[2]["addresses"] == "10 A ST; 22 B ST" and by_row[2]["same_owner"] == "Row 3"
    assert by_row[2]["score"] == 3 + 2 + 2 + 1 and by_row[2]["vacant"] and by_row[2]["absentee"]
    # Living at the property: not absentee; owned over 25 years.
    assert not by_row[4]["absentee"] and by_row[4]["score"] == 1
    assert by_row[5]["government"] and by_row[5]["score"] == 0
    assert by_row[6]["out_of_state"] and by_row[6]["owner"] != by_row[2]["owner"]
    # 125 years of ownership is a fault in the source, not a reason.
    assert by_row[6]["score"] == 2 + 1 and not any("years" in reason for reason in by_row[6]["reasons"])
    assert found["owners"] == 4 and found["government"] == 1 and found["vacant"] == 1
