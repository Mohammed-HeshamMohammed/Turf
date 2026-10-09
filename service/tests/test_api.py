"""The command router Turf has: projects, lists and jobs. Skip Tracing is covered in test_service_skiptrace.py."""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from helpers import call, ok, wait
from turf_service import api
from turf_service.api import Service


def write_csv(path: Path, rows: int) -> Path:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Name", "Phone", "Zip"])
        writer.writerows([f"Person {index}", f"713555{index:04d}", "77008"] for index in range(rows))
    return path


def test_nothing_works_before_a_project_is_open() -> None:
    svc = Service()
    assert ok(svc, "health.check")["status"] == "ok"
    assert ok(svc, "project.current") is None
    assert ok(svc, "project.recent") == []
    assert call(svc, "dataset.list")["error"]["code"] == "no_project"


def test_commands_turf_does_not_have_are_refused() -> None:
    svc = Service()
    for command in ("scrape.create_job", "match.create_job", "collector.install", "project.create_sample", "dataset.cleanup_apply"):
        assert call(svc, command)["error"]["code"] == "unknown_command", command


def test_a_project_is_created_reopened_and_remembered(tmp_path: Path) -> None:
    svc = Service()
    created = ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    assert ok(svc, "project.current")["id"] == created["id"]
    assert [project["name"] for project in ok(svc, "project.recent")] == ["Lists"]
    assert call(svc, "project.create", path=str(tmp_path / "project"), name="Again")["error"]["code"] == "invalid_request"

    # A new service process reopens the most recent project, as Turf does on start.
    restarted = Service()
    restarted.open_recent()
    assert ok(restarted, "project.current")["id"] == created["id"]
    assert call(svc, "project.open", path=str(tmp_path / "nowhere"))["error"]["code"] == "invalid_request"


def test_a_file_is_imported_listed_and_read_in_pages(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    job = wait(svc, ok(svc, "dataset.import", path=str(write_csv(tmp_path / "people.csv", 620)))["job_id"])
    assert job["state"] == "completed", job
    dataset_id = job["result"]["dataset_id"]

    (dataset,) = ok(svc, "dataset.list")
    assert (dataset["id"], dataset["kind"], dataset["row_count"], dataset["column_count"]) == (dataset_id, "import", 620, 3)

    first = ok(svc, "dataset.rows", dataset_id=dataset_id, offset=0, limit=500)
    rest = ok(svc, "dataset.rows", dataset_id=dataset_id, offset=500, limit=500)
    assert (len(first), len(rest)) == (500, 120)
    # No call returns more than the cap, whatever is asked for.
    monkeypatch.setattr(api, "MAX_ROWS_PER_CALL", 100)
    assert len(ok(svc, "dataset.rows", dataset_id=dataset_id, offset=0, limit=100000)) == 100
    assert first[0]["raw"] == {"Name": "Person 0", "Phone": "7135550000", "Zip": "77008"}

    ok(svc, "dataset.delete", dataset_id=dataset_id)
    assert ok(svc, "dataset.list") == []


def test_a_bad_import_is_refused_with_a_reason(tmp_path: Path) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    missing = call(svc, "dataset.import", path=str(tmp_path / "missing.csv"))
    wrong_type = call(svc, "dataset.import", path=str(tmp_path / "notes.txt"))
    assert missing["error"]["code"] == wrong_type["error"]["code"] == "invalid_request"
    assert "existing file" in missing["error"]["message"] and "Supported imports" in wrong_type["error"]["message"]


def test_an_import_leaves_out_empty_rows_and_columns(tmp_path: Path) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    path = tmp_path / "gaps.csv"
    path.write_text(
        "Name,Fax,Phone,Notes,Extra\n"
        "Ada,,7135550001,N/A,\n"
        ",,,,\n"            # every value empty
        " ,,  ,,\n"         # only spaces
        "Grace,,,,\n"
        "\n"                # blank line
        "Alan,,7135550003,,   \n",
        encoding="utf-8",
    )
    job = wait(svc, ok(svc, "dataset.import", path=str(path))["job_id"])
    assert job["state"] == "completed", job
    assert (job["result"]["row_count"], job["result"]["column_count"]) == (3, 3)
    assert (job["result"]["dropped_empty_rows"], job["result"]["dropped_empty_columns"]) == (2, 2)

    rows = ok(svc, "dataset.rows", dataset_id=job["result"]["dataset_id"], offset=0, limit=50)
    # "N/A" is data, so Notes stays; Fax and Extra held nothing. Rows keep the line numbers they had in the file.
    assert [row["raw"] for row in rows] == [
        {"Name": "Ada", "Phone": "7135550001", "Notes": "N/A"},
        {"Name": "Grace", "Phone": "", "Notes": ""},
        {"Name": "Alan", "Phone": "7135550003", "Notes": ""},
    ]
    assert [row["row_number"] for row in rows] == [2, 5, 7]
    (dataset,) = ok(svc, "dataset.list")
    assert (dataset["row_count"], dataset["column_count"]) == (3, 3)


def test_a_file_with_no_data_keeps_its_columns(tmp_path: Path) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    path = tmp_path / "headers.csv"
    path.write_text("Name,Phone\n,\n", encoding="utf-8")
    job = wait(svc, ok(svc, "dataset.import", path=str(path))["job_id"])
    assert (job["result"]["row_count"], job["result"]["column_count"], job["result"]["dropped_empty_rows"]) == (0, 2, 1)


def test_a_copied_project_is_remembered_where_it_was_opened(tmp_path: Path) -> None:
    import shutil

    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "original"), name="Lists")
    svc.store.close()
    shutil.copytree(tmp_path / "original", tmp_path / "copy")

    again = Service()
    opened = ok(again, "project.open", path=str(tmp_path / "copy"))
    assert Path(opened["root_path"]) == tmp_path / "copy"
    assert Path(ok(again, "project.current")["root_path"]) == tmp_path / "copy"
    # Both folders are in the recent list, newest first, each under its own path.
    assert [Path(project["root_path"]).name for project in ok(again, "project.recent")] == ["copy", "original"]


def test_a_list_is_renamed_and_deleted(tmp_path: Path) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    job = wait(svc, ok(svc, "dataset.import", path=str(write_csv(tmp_path / "people.csv", 3)))["job_id"])
    dataset_id = job["result"]["dataset_id"]

    assert ok(svc, "dataset.rename", dataset_id=dataset_id, name="  Houston   owners ")["name"] == "Houston owners"
    (dataset,) = ok(svc, "dataset.list")
    # Only the name changes; the file it came from keeps its own.
    assert (dataset["name"], dataset["source_filename"]) == ("Houston owners", "people.csv")

    assert call(svc, "dataset.rename", dataset_id=dataset_id, name="   ")["error"]["code"] == "invalid_request"
    assert call(svc, "dataset.rename", dataset_id="nothing", name="X")["error"]["code"] == "not_found"

    ok(svc, "dataset.delete", dataset_id=dataset_id)
    assert ok(svc, "dataset.list") == []
    assert ok(svc, "dataset.rows", dataset_id=dataset_id, offset=0, limit=10) == []
