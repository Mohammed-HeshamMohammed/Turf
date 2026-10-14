"""Combining lists into one: each lead once, whatever the lists call their columns."""

from __future__ import annotations

import csv
from pathlib import Path

from helpers import call, ok, wait
from test_service_skiptrace import run, service  # noqa: F401

COUNTY = [
    ["Owner", "Site Address", "City", "State", "Zip", "Mail Address"],
    ["SMITH JOHN A", "12 Main Street", "Houston", "TX", "77008", "12 Main Street"],
    ["GARCIA MARIA", "40 Oak Avenue", "Houston", "TX", "77008", "PO Box 9"],
    ["LEE ANN", "7 Elm St", "Houston", "TX", "77002", "7 Elm St"],
]
TRACED = [
    ["Owner Name", "Property Address", "City", "State", "Zip", "Phone", "Email"],
    ["John Smith", "12 Main St", "Houston", "TX", "77008", "(713) 555-3142", "john@example.com"],
    ["Maria Garcia", "40 Oak Ave", "Houston", "TX", "77008", "713-555-8877", ""],
    ["Wei Nguyen", "305 Cedar Ln", "Houston", "TX", "77019", "713-555-6600", ""],
]


def add(svc, tmp_path: Path, name: str, table: list[list[str]]) -> str:
    path = tmp_path / f"{name}.csv"
    with path.open("w", encoding="utf-8", newline="") as handle:
        csv.writer(handle).writerows(table)
    job = wait(svc, ok(svc, "dataset.import", path=str(path), name=name)["job_id"])
    assert job["state"] == "completed", job
    return job["result"]["dataset_id"]


def setup(svc, dataset: str, **columns) -> None:
    config = {**ok(svc, "skiptrace.suggest", dataset_id=dataset)["config"], **columns}
    if not config["phone_columns"]:
        # A list with no phones has no Skip Tracing setup to save; combining uses what Turf suggests for it.
        return
    ok(svc, "skiptrace.save_settings", dataset_id=dataset, config=config)


def lists(svc, tmp_path):
    county = add(svc, tmp_path, "County roll", COUNTY)
    traced = add(svc, tmp_path, "Traced", TRACED)
    setup(svc, traced, name_column="Owner Name", address_column="Property Address")
    return county, traced


def test_two_lists_with_different_columns_become_one_with_each_lead_once(service, tmp_path):
    county, traced = lists(service, tmp_path)
    preview = run(service, "lists.combine", dataset_ids=[traced, county], preview=True)["summary"]
    assert preview["counts"] == {"all": 4, "shared": 2, "in_all": 2, "only": [1, 1]}
    assert [(item["name"], item["rows"], item["only_here"], item["elsewhere"]) for item in preview["lists"]] == [("Traced", 3, 1, 2), ("County roll", 3, 1, 2)]
    assert preview["examples"][0]["rows"][0]["list"] == "Traced" and preview["examples"][0]["rows"][1]["dataset_id"] == county
    assert ok(service, "dataset.list")[0]["name"] in ("Traced", "County roll"), "a preview saves nothing"

    made = run(service, "lists.combine", dataset_ids=[traced, county], name="Everyone")
    rows = [row["raw"] for row in ok(service, "dataset.rows", dataset_id=made["dataset_id"])]
    assert made["rows"] == 4 and len(rows) == 4
    john = next(row for row in rows if row["Owner Name"] == "John Smith")
    # One row for John: the traced row kept (it has the phone), the county roll's mailing address filled in.
    assert john["Phone"] == "(713) 555-3142" and john["Mail Address"] == "12 Main Street" and john["In lists"] == "Traced; County roll"
    assert john["Combined from"] == "Traced row 2; County roll row 2"
    maria = next(row for row in rows if row["Owner Name"] == "Maria Garcia")
    assert maria["Phone"] == "713-555-8877" and maria["Mail Address"] == "PO Box 9" and "Other phones" not in maria, "the row with a phone is kept, and nothing is said twice"
    assert "Owner" not in john and "Site Address" not in john, "the county roll's owner and address are the same columns under other names"
    assert [row["In lists"] for row in rows].count("County roll") == 1 and next(row for row in rows if row["In lists"] == "County roll")["Owner Name"] == "LEE ANN"
    saved = next(item for item in ok(service, "dataset.list") if item["id"] == made["dataset_id"])
    assert saved["kind"] == "combined" and saved["name"] == "Everyone"
    assert len(ok(service, "dataset.rows", dataset_id=county)) == 3, "the lists themselves are untouched"


def test_what_comes_out_is_chosen(service, tmp_path):
    county, traced = lists(service, tmp_path)
    shared = run(service, "lists.combine", dataset_ids=[traced, county], mode="in_all", name="In both")
    assert shared["rows"] == 2
    only = run(service, "lists.combine", dataset_ids=[traced, county], mode=f"only:{county}", name="New in the county roll")
    assert [row["raw"]["Owner Name"] for row in ok(service, "dataset.rows", dataset_id=only["dataset_id"])] == ["LEE ANN"]
    assert not call(service, "lists.combine", dataset_ids=[traced])["ok"]
    assert not call(service, "lists.combine", dataset_ids=[traced, county], mode="only:nothing")["ok"]


def test_a_decision_across_lists_is_followed(service, tmp_path):
    county, traced = lists(service, tmp_path)
    ok(service, "duplicates.overrule", dataset_id=traced, row_number=2, other_dataset_id=county, other_row_number=2, same=False)
    ok(service, "duplicates.overrule", dataset_id=traced, row_number=4, other_dataset_id=county, other_row_number=4, same=True)
    summary = run(service, "lists.combine", dataset_ids=[traced, county], preview=True)["summary"]
    # John is two leads now, and Wei Nguyen and Ann Lee one, because the person said so.
    assert summary["counts"]["all"] == 4 and summary["counts"]["shared"] == 2 and summary["overruled"] == 2
    assert any(example["why"] == "You said these are the same lead" for example in summary["examples"])


def test_a_property_with_another_owner_in_another_list_is_pointed_out(service, tmp_path):
    older = add(service, tmp_path, "March", [["Owner Name", "Property Address", "City", "State", "Zip"], ["John Smith", "12 Main St", "Houston", "TX", "77008"], ["Ann Lee", "7 Elm St", "Houston", "TX", "77002"]])
    newer = add(service, tmp_path, "April", [["Owner", "Site Address", "City", "State", "Zip"], ["GARCIA MARIA", "12 Main Street", "Houston", "TX", "77008"], ["LEE ANN", "7 Elm St", "Houston", "TX", "77002"]])
    summary = run(service, "lists.combine", dataset_ids=[older, newer], preview=True)["summary"]
    assert summary["owner_differs"] == 1 and summary["counts"]["shared"] == 1
    assert [row["label"].split(" · ")[0] for row in summary["owner_differs_examples"][0]["rows"]] == ["John Smith", "GARCIA MARIA"]
