"""Rows that repeat the same lead: what counts as a duplicate in a list of leads, and what does not."""

from __future__ import annotations

from turf_matching import duplicates

CONFIG = {
    "phone_columns": ["Phone"], "region": "US", "name_column": "Owner", "address_column": "Address", "city_column": "City",
    "state_column": "State", "zip_column": "Zip", "mailing_address_column": "Mailing Address",
}


def lead(owner="", address="", phone="", zip_code="77008", mailing="", email="", city="Houston"):
    return {"Owner": owner, "Address": address, "City": city, "State": "TX", "Zip": zip_code, "Mailing Address": mailing, "Phone": phone, "Email": email}


def find(rows, checked=None):
    numbers = list(range(2, len(rows) + 2))
    return duplicates.find(rows, numbers, CONFIG, checked)


def statuses(out):
    return [row["Duplicate status"] for row in out]


def test_the_same_lead_written_twice_is_a_duplicate_and_the_first_complete_row_is_kept():
    out, summary = find([
        lead("John Smith", "12 Main St", "(713) 555-0142"),
        lead("Maria Garcia", "40 Oak Ave", "713-555-0188"),
        lead("JOHN SMITH", "12 Main Street", "7135550142"),
    ])
    assert statuses(out) == ["Keep", "", "Duplicate of row 2"]
    assert out[0]["Duplicate group"] == out[2]["Duplicate group"] == "D1" and out[1]["Duplicate group"] == ""
    assert "phone" in out[2]["Duplicate why"] and "name" in out[2]["Duplicate why"] and "property address" in out[2]["Duplicate why"]
    assert (summary["groups"], summary["duplicate_rows"], summary["possible_rows"]) == (1, 1, 0)
    assert summary["examples"][0]["rows"][0] == {"row_number": 2, "keep": True, "label": "John Smith · 12 Main St · +17135550142"}


def test_a_county_roll_name_is_the_same_name():
    """Surname first, in capitals, with a middle initial, and no phone on one side."""
    out, _ = find([lead("SMITH JOHN A", "12 Main St"), lead("John Smith", "12 Main Street", "713-555-0142")])
    assert statuses(out) == ["Duplicate of row 3", "Keep"] or statuses(out) == ["Keep", "Duplicate of row 2"]


def test_the_row_with_the_best_number_to_call_is_the_one_kept():
    rows = [lead("John Smith", "12 Main St", "713-555-0142"), lead("John Smith", "12 Main St", "713-555-0199")]
    checked = [
        {"Phone (E.164)": "+17135550142", "Best phone": "", "Best phone verdict": "wrong"},
        {"Phone (E.164)": "+17135550199", "Best phone": "+17135550199", "Best phone verdict": "corroborated"},
    ]
    out, _ = find(rows, checked)
    assert statuses(out) == ["Duplicate of row 3", "Keep"]
    assert "best number to call" in out[1]["Duplicate why"] and "row 2 has a phone this row does not" in out[1]["Duplicate why"]


def test_a_number_the_check_could_not_read_as_valid_is_still_the_same_number():
    rows = [lead("John Smith", "", "555-0142"), lead("John Smith", "", "555 0142")]
    checked = [{"Phone (E.164)": "", "Best phone": "", "Best phone verdict": "wrong"}] * 2
    out, _ = find(rows, checked)
    assert statuses(out) == ["Keep", "Duplicate of row 2"] and "phone" in out[1]["Duplicate why"]


def test_one_owner_with_several_properties_is_not_a_duplicate():
    out, summary = find([
        lead("John Smith", "12 Main St", "713-555-0142", mailing="900 Pine Rd"),
        lead("John Smith", "77 Elm St", "713-555-0142", zip_code="77002", mailing="900 Pine Rd"),
        lead("John Smith", "305 Cedar Ln", "713-555-0142", zip_code="77019", mailing="900 Pine Rd"),
    ])
    assert statuses(out) == ["", "", ""]
    assert [row["Same owner rows"] for row in out] == ["Rows 3, 4", "Rows 2, 4", "Rows 2, 3"]
    assert (summary["groups"], summary["owner_groups"], summary["owner_rows"]) == (0, 1, 3)


def test_people_of_one_household_are_not_each_other():
    out, summary = find([lead("John Smith", "12 Main St", "713-555-0142"), lead("Mary Smith", "12 Main St", "713-555-0142")])
    assert statuses(out) == ["", ""] and summary["groups"] == 0


def test_a_household_line_and_one_of_its_people_at_the_same_property_are_one_lead():
    out, _ = find([lead("SMITH JOHN & MARY", "12 Main St", "713-555-0142"), lead("John Smith", "12 Main St", "713-555-0142")])
    assert sorted(statuses(out)) == ["Duplicate of row 2", "Keep"]


def test_a_company_is_compared_without_its_legal_form():
    out, _ = find([lead("Lone Star Holdings LLC", "40 Oak Ave", "713-555-0188"), lead("LONE STAR HOLDINGS, L.L.C.", "40 Oak Avenue", "")])
    assert statuses(out) == ["Keep", "Duplicate of row 2"]
    other, _ = find([lead("Lone Star Holdings LLC", "40 Oak Ave", "713-555-0188"), lead("Gulf Coast Realty LLC", "40 Oak Ave", "713-555-0188")])
    assert "Keep" not in statuses(other)


def test_an_office_number_on_many_rows_is_not_evidence():
    names = ["Ann Lee", "Bo Diaz", "Cy Ward", "Di Cole", "Ed Ruiz", "Flo Kent", "Gus Hart"]
    out, summary = find([lead(name, f"{index + 1}00 Oak Ave", "713-555-0100", zip_code=f"770{index:02d}") for index, name in enumerate(names)])
    assert statuses(out) == [""] * 7 and summary["ignored_shared_values"] == 1 and summary["owner_groups"] == 0


def test_the_same_phone_alone_is_only_a_possible_duplicate():
    out, summary = find([lead("", "", "713-555-0142"), lead("", "", "713-555-0142")])
    assert statuses(out) == ["Possible duplicate of row 3", "Possible duplicate of row 2"]
    assert all("not enough to be sure" in row["Duplicate why"] for row in out) and summary["possible_rows"] == 2 and summary["groups"] == 0


def test_a_list_without_duplicates_says_so_and_changes_nothing():
    rows = [lead("John Smith", "12 Main St", "713-555-0142"), lead("Maria Garcia", "40 Oak Ave", "713-555-0188")]
    out, summary = find(rows)
    assert all(not any(row.values()) for row in out) and set(out[0]) == set(duplicates.COLUMNS)
    assert (summary["groups"], summary["possible_rows"], summary["owner_groups"]) == (0, 0, 0)


# ------------------------------------------------------------------------------- through the phone check itself

from helpers import ok  # noqa: E402
from test_service_skiptrace import make_dataset, run, service  # noqa: E402, F401

REPEATED = [
    ["Ana", "Lopez", "(713) 555-3142", "", "77009", "TX", ""],
    ["Ben", "Ortiz", "(713) 555-7788", "", "77018", "TX", ""],
    ["ANA", "LOPEZ", "713-555-3142", "(713) 555-4455", "77009", "TX", ""],
    ["Cy", "Young", "(713) 555-6677", "", "77019", "TX", ""],
]


def test_the_phone_check_marks_repeated_leads_and_the_saved_copy_carries_them(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Repeated", REPEATED)
    config = ok(service, "skiptrace.suggest", dataset_id=dataset)["config"]
    assert ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)["find_duplicates"] is True
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert (report["duplicates"]["groups"], report["duplicates"]["duplicate_rows"]) == (1, 1)
    assert (report["row_counts"]["duplicates"], report["row_counts"]["possible_duplicates"], report["row_counts"]["same_owner"]) == (2, 0, 0)
    assert report["added_columns"][-4:] == ["Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows"]

    reviewed = ok(service, "skiptrace.review", job_id=report["scan_job_id"], filter="duplicates")
    assert reviewed["total"] == 2
    assert [row["raw"]["Duplicate status"] for row in reviewed["rows"]] == ["Keep", f"Duplicate of row {reviewed['rows'][0]['row_number']}"]
    assert ok(service, "skiptrace.review", job_id=report["scan_job_id"], filter="possible_duplicates")["total"] == 0

    saved = run(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"])
    rows = ok(service, "dataset.rows", dataset_id=saved["dataset_id"])
    assert len(rows) == len(REPEATED), "no row is removed"
    assert [row["raw"]["Duplicate group"] for row in rows] == ["D1", "", "D1", ""]
    assert ok(service, "dataset.rows", dataset_id=dataset)[0]["raw"].get("Duplicate group") is None, "the original list is untouched"


def test_looking_for_duplicates_can_be_turned_off(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Repeated", REPEATED)
    config = {**ok(service, "skiptrace.suggest", dataset_id=dataset)["config"], "find_duplicates": False}
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert report["duplicates"] is None and report["row_counts"]["duplicates"] == 0
    assert "Duplicate group" not in report["added_columns"]
    assert ok(service, "skiptrace.review", job_id=report["scan_job_id"], filter="duplicates")["total"] == 0
