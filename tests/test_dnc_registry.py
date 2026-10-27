"""The National Do Not Call Registry, imported from the person's own download."""

from __future__ import annotations

import json
import zipfile

from helpers import call, ok
from test_service_skiptrace import FILE_A, confirmed, make_dataset, run, service  # noqa: F401
from turf_service import dnc_registry


def test_numbers_are_read_whatever_the_punctuation():
    assert dnc_registry.numbers_in("7135553142\n") == ["7135553142"]
    assert dnc_registry.numbers_in("713,5553142") == ["7135553142"]
    assert dnc_registry.numbers_in("(713) 555-3142") == ["7135553142"]
    assert dnc_registry.numbers_in("<phone>17135553142</phone>") == ["7135553142"]
    assert dnc_registry.numbers_in("7135553142,8325550100") == ["7135553142", "8325550100"]
    assert dnc_registry.numbers_in("Area code,Phone") == [] and dnc_registry.numbers_in("12345") == []


def test_a_file_replaces_its_area_codes_and_is_checked_by_lookup(tmp_path):
    first = tmp_path / "713.txt"
    first.write_text("7135553142\n7135554455\n2815550100\nheader line\n", encoding="utf-8")
    result = dnc_registry.import_file(first)
    assert result["area_codes"] == ["281", "713"] and result["numbers"] == 3 and result["skipped_lines"] == 1
    assert dnc_registry.listed("+17135553142").startswith("National Do Not Call Registry (file of ")
    assert dnc_registry.listed("+17135550000") is None and dnc_registry.listed("+18325553142") is None, "other area codes are not checked"
    archive = tmp_path / "fresh.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("713.txt", "7135559999\n")
    dnc_registry.import_file(archive)
    assert dnc_registry.listed("+17135553142") is None and dnc_registry.listed("+17135559999"), "a fresh file replaces its area code"
    assert dnc_registry.listed("+12815550100"), "area codes not in the fresh file stay"
    state = dnc_registry.status()
    assert [entry["area_code"] for entry in state["area_codes"]] == ["281", "713"] and state["numbers"] == 2
    assert not state["area_codes"][0]["out_of_date"]
    dnc_registry.remove("281")
    assert dnc_registry.listed("+12815550100") is None


def test_a_number_on_the_registry_is_blocked_in_a_phone_check(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Registry", FILE_A)
    config = confirmed(service, dataset)
    before = ok(service, "skiptrace.freshness", dataset_id=dataset)["fingerprint"]
    registry = tmp_path / "dnc.txt"
    registry.write_text("7135552211\n", encoding="utf-8")  # Ed Shaw's number in FILE_A
    imported = run(service, "dnc_registry.import", path=str(registry))
    assert imported["numbers"] == 1
    assert ok(service, "skiptrace.freshness", dataset_id=dataset)["fingerprint"] != before, "an import makes earlier checks out of date"
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    ed = next(item for item in report["preview"] if item["raw"]["First Name"] == "Ed")
    choice = json.loads(ed["raw"]["Phone choices"])[0]
    assert choice["permission"] == "blocked_dnc" and choice["blocked"]
    assert "National Do Not Call Registry" in ed["raw"]["Phone (why)"]
    assert not call(service, "dnc_registry.import", path=str(tmp_path / "missing.txt"))["ok"]
