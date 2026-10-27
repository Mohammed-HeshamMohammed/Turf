"""Lists already in a project lose their empty rows and columns when the project is opened, unless something depends on them."""

from __future__ import annotations

import json
from pathlib import Path

from helpers import call, ok, wait
from turf_service import datasets, tidy
from turf_service.api import Service

HEADERS = ["Name", "", "Phone", "Fax"]
ROWS = [
    {"Name": "Ada", "column_2": "", "Phone": "7135550001", "Fax": ""},
    {"Name": "", "column_2": "", "Phone": " ", "Fax": ""},          # nothing in it
    {"Name": "Grace", "column_2": "", "Phone": "", "Fax": None},
]


def add_old_list(svc: Service, tmp_path: Path, name: str = "Old list") -> str:
    """A list as an import looked before imports left out what is empty, or as DataForge imports one."""
    store = svc.store
    created = datasets._register_rows(
        store, svc.project["id"], tmp_path / f"{name}.csv", name.encode(), ["Name", "column_2", "Phone", "Fax"], [dict(row) for row in ROWS], name,
        kind="scrape",
    )
    store._connection.execute("UPDATE datasets SET kind = 'import' WHERE id = ?", (created.dataset_id,))
    store._connection.commit()
    return created.dataset_id


def project_with_old_list(tmp_path: Path) -> tuple[Service, str]:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    return svc, add_old_list(svc, tmp_path)


def reopen(tmp_path: Path) -> tuple[Service, dict]:
    svc = Service()
    return svc, ok(svc, "project.open", path=str(tmp_path / "project"))


def shape(svc: Service, dataset_id: str) -> tuple[int, int, list[dict]]:
    dataset = next(item for item in ok(svc, "dataset.list") if item["id"] == dataset_id)
    rows = ok(svc, "dataset.rows", dataset_id=dataset_id, offset=0, limit=50)
    return dataset["row_count"], dataset["column_count"], [row["raw"] for row in rows]


def test_an_old_list_is_tidied_once_when_its_project_is_opened(tmp_path: Path) -> None:
    first, dataset_id = project_with_old_list(tmp_path)
    assert shape(first, dataset_id)[:2] == (3, 4)
    first.store.close()

    svc, opened = reopen(tmp_path)
    assert opened["tidied"] == [{"dataset_id": dataset_id, "name": "Old list", "dropped_empty_rows": 1, "dropped_empty_columns": 2}]
    assert ok(svc, "project.current")["tidied"] == opened["tidied"]
    assert shape(svc, dataset_id) == (2, 2, [{"Name": "Ada", "Phone": "7135550001"}, {"Name": "Grace", "Phone": ""}])
    # Rows keep the numbers they had.
    assert [row["row_number"] for row in ok(svc, "dataset.rows", dataset_id=dataset_id, offset=0, limit=50)] == [2, 4]
    svc.store.close()

    # The next opening has nothing to do and does not read the list again.
    again, opened_again = reopen(tmp_path)
    assert opened_again["tidied"] == []
    assert dataset_id in tidy._checked(again.store)


def test_a_list_something_depends_on_is_left_as_it_is(tmp_path: Path) -> None:
    first, dataset_id = project_with_old_list(tmp_path)
    # A copy made from the list: its rows line up with the list's, so the list must keep its shape.
    copy = datasets._register_rows(first.store, first.project["id"], tmp_path / "copy.json", b"copy", ["Name"], [{"Name": "Ada"}], "Copy", kind="checked")
    first.store._connection.execute("UPDATE datasets SET parent_dataset_id = ? WHERE id = ?", (dataset_id, copy.dataset_id))
    first.store._connection.commit()
    first.store.close()

    svc, opened = reopen(tmp_path)
    assert opened["tidied"] == []
    assert shape(svc, dataset_id)[:2] == (3, 4)


def test_a_list_whose_saved_setup_names_an_empty_column_is_left_as_it_is(tmp_path: Path) -> None:
    first, dataset_id = project_with_old_list(tmp_path)
    config = ok(first, "skiptrace.suggest", dataset_id=dataset_id)["config"]
    ok(first, "skiptrace.save_settings", dataset_id=dataset_id, config={**config, "phone_columns": ["Phone", "Fax"]})
    first.store.close()

    svc, opened = reopen(tmp_path)
    assert opened["tidied"] == []
    assert shape(svc, dataset_id)[:2] == (3, 4)


def test_a_list_with_nothing_to_take_out_is_untouched(tmp_path: Path) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    path = tmp_path / "full.csv"
    path.write_text("Name,Phone\nAda,7135550001\n", encoding="utf-8")
    job = wait(svc, ok(svc, "dataset.import", path=str(path))["job_id"])
    dataset_id = job["result"]["dataset_id"]
    # A list Turf imported is already clean and is remembered as such.
    assert dataset_id in tidy._checked(svc.store)
    before = svc.store._connection.execute("SELECT raw_values_json FROM source_rows WHERE dataset_id = ?", (dataset_id,)).fetchall()
    svc.store.close()

    again, opened = reopen(tmp_path)
    assert opened["tidied"] == []
    after = again.store._connection.execute("SELECT raw_values_json FROM source_rows WHERE dataset_id = ?", (dataset_id,)).fetchall()
    assert [json.loads(row[0]) for row in before] == [json.loads(row[0]) for row in after] == [{"Name": "Ada", "Phone": "7135550001"}]


def test_a_list_that_is_empty_throughout_is_not_emptied(tmp_path: Path) -> None:
    svc = Service()
    ok(svc, "project.create", path=str(tmp_path / "project"), name="Lists")
    created = datasets._register_rows(svc.store, svc.project["id"], tmp_path / "blank.csv", b"blank", ["A", "B"], [{"A": "", "B": ""}, {"A": " ", "B": None}], "Blank", kind="scrape")
    svc.store._connection.execute("UPDATE datasets SET kind = 'import' WHERE id = ?", (created.dataset_id,))
    svc.store._connection.commit()
    svc.store.close()

    again, opened = reopen(tmp_path)
    assert opened["tidied"] == []
    assert shape(again, created.dataset_id)[:2] == (2, 2)
    assert call(again, "dataset.rows", dataset_id=created.dataset_id, offset=0, limit=5)["ok"]
