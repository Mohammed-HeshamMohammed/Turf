"""Importing delimited text and non-UTF-8 files, and what deleting a list leaves in the project."""

from __future__ import annotations

from pathlib import Path

from helpers import call, ok, wait
from callerwhale_service.api import Service

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
    second = imported(svc, source, name="Again", allow_duplicate=True)
    assert len(stored()) == 1
    ok(svc, "dataset.delete", dataset_id=first)
    assert len(stored()) == 1, "the other list still has the same file"
    ok(svc, "dataset.delete", dataset_id=second)
    assert stored() == []


def test_a_long_list_is_not_read_through_for_every_column() -> None:
    """The setup suggestion reads only status-like columns to the end, and samples stop once each column has three."""
    from callerwhale_matching import skiptrace as engine
    from callerwhale_service.skiptrace import _samples

    rows = [{"Name": f"Person {index}", "State": "TX", "Phone": f"713555{index:04d}", "Call Status": ("LVM", "Wrong number", "")[index % 3]} for index in range(500)]
    found = engine.suggest(rows, {})
    assert [item["column"] for item in found["outcome_candidates"]] == ["Call Status"]
    assert found["outcome_candidates"][0]["filled"] == 334 and found["outcome_candidates"][0]["distinct"] == 2
    assert _samples(rows, ["Name", "State", "Call Status"]) == {"Name": ["Person 0", "Person 1", "Person 2"], "State": ["TX"], "Call Status": ["LVM", "Wrong number"]}


# ------------------------------------------------------------------- the same list is never added a second time

LEADS = [["Owner", "Address", "Zip", "Phone"]] + [[f"Person {index}", f"{index} Oak Ave", "77008", f"713555{1000 + index}"] for index in range(40)]


def write(path: Path, table: list[list[str]]) -> Path:
    path.write_text("\n".join(",".join(row) for row in table) + "\n", encoding="utf-8")
    return path


def attempt(svc: Service, path: Path, **payload) -> dict:
    job = wait(svc, ok(svc, "dataset.import", path=str(path), **payload)["job_id"])
    assert job["state"] == "completed", job
    return job["result"]


def test_the_same_file_under_another_name_is_not_added_again(tmp_path: Path) -> None:
    svc = project(tmp_path)
    first = attempt(svc, write(tmp_path / "march.csv", LEADS))
    assert first["dataset_id"] and first["already"] is None and first["overlaps"] == []
    again = attempt(svc, write(tmp_path / "march (copy).csv", LEADS))
    assert again["dataset_id"] is None and again["already"]["how"] == "same_file" and again["already"]["name"] == "march"
    assert len(ok(svc, "dataset.list")) == 1
    assert attempt(svc, tmp_path / "march (copy).csv", allow_duplicate=True)["dataset_id"], "the person may add it all the same"


def test_the_same_rows_with_other_column_names_in_another_order_and_format_are_known(tmp_path: Path) -> None:
    svc = project(tmp_path)
    attempt(svc, write(tmp_path / "march.csv", LEADS))
    renamed = [["PHONE NUMBER", "Owner Name", "Postal", "Street"]] + [[row[3], row[0].upper() if index % 2 else row[0], row[2], f"  {row[1]} "] for index, row in enumerate(LEADS[1:])]
    table = tmp_path / "export.tsv"
    table.write_text("\n".join("\t".join(row) for row in renamed) + "\n", encoding="utf-8")
    result = attempt(svc, table)
    assert result["dataset_id"] is None and result["already"]["how"] == "same_rows" and result["already"]["share"] == 1.0
    assert len(ok(svc, "dataset.list")) == 1, "the file that was read to compare it is not left in the project"
    assert not list((tmp_path / "project" / "artifacts" / "sha256").rglob("*.tsv"))


def test_a_part_of_a_list_is_not_added_but_a_longer_or_different_one_is(tmp_path: Path) -> None:
    svc = project(tmp_path)
    attempt(svc, write(tmp_path / "march.csv", LEADS))
    part = attempt(svc, write(tmp_path / "first ten.csv", LEADS[:11]))
    assert part["dataset_id"] is None and part["already"]["how"] == "all_inside"
    more = LEADS + [[f"New {index}", f"{index} Elm St", "77002", f"713555{5000 + index}"] for index in range(20)]
    longer = attempt(svc, write(tmp_path / "april.csv", more))
    assert longer["dataset_id"] and [(item["name"], item["of_other"]) for item in longer["overlaps"]] == [("march", 1.0)]
    assert longer["overlaps"][0]["share"] == round(40 / 60, 4)
    other = attempt(svc, write(tmp_path / "other.csv", [["Owner", "Phone"], ["Someone Else", "7135559999"]]))
    assert other["dataset_id"] and other["overlaps"] == []


def test_a_long_list_is_known_again_from_its_sketch(tmp_path: Path) -> None:
    from callerwhale_service import sameness

    def rows(start: int, count: int):
        return [{"Owner": f"Person {index}", "Phone": f"{7130000000 + index}"} for index in range(start, start + count)]

    whole, same, half, apart = (sameness.sketch(rows(*span)) for span in ((0, 20000), (0, 20000), (10000, 20000), (50000, 20000)))
    assert whole["rows"] == 20000 and len(whole["keys"]) == sameness.SKETCH
    assert sameness.shared(whole, same) == (1.0, 1.0)
    assert abs(sameness.shared(whole, half)[0] - 0.5) < 0.04 and sameness.shared(whole, apart) == (0.0, 0.0)


def test_a_dropped_file_arrives_as_its_content_and_leaves_nothing_behind(tmp_path: Path, monkeypatch) -> None:
    import base64

    from callerwhale_service import projects

    svc = project(tmp_path)
    data = base64.b64encode(write(tmp_path / "march.csv", LEADS).read_bytes()).decode("ascii")
    job = wait(svc, ok(svc, "dataset.import_content", name="march.csv", data=data)["job_id"])
    assert job["state"] == "completed" and job["result"]["row_count"] == 40
    assert ok(svc, "dataset.list")[0]["name"] == "march"
    again = wait(svc, ok(svc, "dataset.import_content", name="renamed.csv", data=data)["job_id"])["result"]
    assert again["dataset_id"] is None and again["already"]["name"] == "march"
    assert not any((projects.app_data_dir() / "dropped").iterdir())
    assert not call(svc, "dataset.import_content", name="notes.pdf", data=data)["ok"]


def test_rows_read_compactly_are_the_same_rows(tmp_path: Path) -> None:
    svc = project(tmp_path)
    dataset = attempt(svc, write(tmp_path / "march.csv", LEADS))["dataset_id"]
    plain = ok(svc, "dataset.rows", dataset_id=dataset, offset=5, limit=10)
    compact = ok(svc, "dataset.rows_compact", dataset_id=dataset, offset=5, limit=10)
    assert [{"id": row[0], "row_number": row[1], "raw": dict(zip(compact["columns"], row[2:]))} for row in compact["rows"]] == plain
    assert ok(svc, "dataset.rows_compact", dataset_id=dataset, offset=100, limit=10) == {"columns": [], "rows": []}
