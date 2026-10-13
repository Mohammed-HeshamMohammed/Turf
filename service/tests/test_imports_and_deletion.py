"""Importing delimited text and non-UTF-8 files, and what deleting a list leaves in the project."""

from __future__ import annotations

from pathlib import Path

from helpers import ok, wait
from turf_service.api import Service

TAB = chr(9)
E_ACUTE = bytes([0xC9])  # "É" in Windows-1252, which is not valid UTF-8 on its own


def project(tmp_path: Path) -> Service:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    return svc


def imported(svc: Service, path: Path, **payload) -> str:
    job = wait(svc, ok(svc, "dataset.import", path=str(path), **payload)["job_id"])
    assert job["state"] == "completed", job
    return job["result"]["dataset_id"]


def test_tab_and_pipe_delimited_text_files_import_like_any_list(tmp_path: Path) -> None:
    svc = project(tmp_path)
    county = tmp_path / "real_acct.txt"
    county.write_bytes(f"acct{TAB}mailto{TAB}site_addr_1\n001{TAB}CAF".encode() + E_ACUTE + f" LLC{TAB}1200 EXAMPLE ST\n".encode())
    piped = tmp_path / "owners.tsv"
    piped.write_text("Owner|Zip\nSmith|77009\n", encoding="utf-8")
    assert ok(svc, "dataset.rows", dataset_id=imported(svc, county))[0]["raw"]["mailto"] == "CAFÉ LLC"
    assert ok(svc, "dataset.rows", dataset_id=imported(svc, piped))[0]["raw"] == {"Owner": "Smith", "Zip": "77009"}


def test_a_csv_that_is_not_utf8_is_read_as_windows_1252(tmp_path: Path) -> None:
    svc = project(tmp_path)
    source = tmp_path / "export.csv"
    source.write_bytes(b"Owner,Zip\nCAF" + E_ACUTE + b" LLC,77009\n")
    assert ok(svc, "dataset.rows", dataset_id=imported(svc, source))[0]["raw"]["Owner"] == "CAFÉ LLC"


def test_deleting_a_list_removes_its_stored_file_unless_something_still_needs_it(tmp_path: Path) -> None:
    svc = project(tmp_path)
    source = tmp_path / "people.csv"
    source.write_text("Name,Phone\nAda,7135550000\n", encoding="utf-8")

    def stored() -> list[Path]:
        return [path for path in (tmp_path / "project" / "artifacts" / "sha256").rglob("*") if path.is_file()]

    first = imported(svc, source)
    second = imported(svc, source, name="Again")
    assert len(stored()) == 1
    ok(svc, "dataset.delete", dataset_id=first)
    assert len(stored()) == 1, "the other list still has the same file"
    ok(svc, "dataset.delete", dataset_id=second)
    assert stored() == []


def test_a_long_list_is_not_read_through_for_every_column() -> None:
    """The setup suggestion reads only status-like columns to the end, and samples stop once each column has three."""
    from turf_matching import skiptrace as engine
    from turf_service.skiptrace import _samples

    rows = [{"Name": f"Person {index}", "State": "TX", "Phone": f"713555{index:04d}", "Call Status": ("LVM", "Wrong number", "")[index % 3]} for index in range(500)]
    found = engine.suggest(rows, {})
    assert [item["column"] for item in found["outcome_candidates"]] == ["Call Status"]
    assert found["outcome_candidates"][0]["filled"] == 334 and found["outcome_candidates"][0]["distinct"] == 2
    assert _samples(rows, ["Name", "State", "Call Status"]) == {"Name": ["Person 0", "Person 1", "Person 2"], "State": ["TX"], "Call Status": ["LVM", "Wrong number"]}
