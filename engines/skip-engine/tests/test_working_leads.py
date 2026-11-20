"""Working the leads: stages, notes and callbacks that follow a lead, call and mail lists, deleted lists, backups."""

from __future__ import annotations

import base64
import csv
import io
import zipfile
from pathlib import Path

from helpers import call, ok, wait
from test_combine import COUNTY, TRACED, add
from test_service_skiptrace import run, service  # noqa: F401


def checked(svc, dataset: str) -> str:
    config = {**ok(svc, "skiptrace.suggest", dataset_id=dataset)["config"], "name_column": "Owner Name", "address_column": "Property Address"}
    return run(svc, "skiptrace.apply", dataset_id=dataset, config=config)["dataset_id"]


def export(svc, **payload) -> tuple[dict, list[dict]]:
    made = ok(svc, "export.prepare", **payload)
    text = base64.b64decode(ok(svc, "export.chunk", token=made["token"], offset=0)["data"]).decode("utf-8-sig")
    return made, list(csv.DictReader(io.StringIO(text)))


def test_a_stage_a_note_and_a_callback_follow_the_lead_into_another_list(service, tmp_path):
    county = add(service, tmp_path, "County roll", COUNTY)
    traced = add(service, tmp_path, "Traced", TRACED)
    state = ok(service, "leads.set", dataset_id=traced, row_number=2, stage="interested", callback_on="2026-10-20", callback_note="  wants  an offer ")
    assert (state["stage"], state["callback_on"], state["callback_note"]) == ("interested", "2026-10-20", "wants an offer")
    assert [item["note"] for item in ok(service, "leads.add_note", dataset_id=traced, row_number=2, note="Wants $240k")] == ["Wants $240k"]

    # The county roll writes the same property another way, under other column names: it is the same lead.
    there = ok(service, "leads.for_list", dataset_id=county)
    key = there["keys"]["2"]
    assert there["states"][key]["stage"] == "interested" and there["notes"][key] == 1
    assert [item["note"] for item in ok(service, "leads.notes", dataset_id=county, row_number=2)] == ["Wants $240k"]
    assert there["keys"]["4"] not in there["states"], "another property is another lead"

    due = ok(service, "leads.due", today="2026-10-20")
    assert [(item["label"].split(" · ")[0], item["note"], item["list"]) for item in due["due"]] == [("John Smith", "wants an offer", "Traced")]
    assert ok(service, "leads.due", today="2026-10-19")["due"] == [] and len(ok(service, "leads.due", today="2026-10-19")["coming"]) == 1
    assert due["stages"]["interested"] == 1

    assert ok(service, "leads.set", dataset_id=traced, row_number=2, callback_on=None)["callback_on"] is None
    assert ok(service, "leads.due", today="2026-10-20")["due"] == []
    note = ok(service, "leads.notes", dataset_id=traced, row_number=2)[0]
    assert ok(service, "leads.remove_note", dataset_id=traced, row_number=2, id=note["id"]) == []
    assert not call(service, "leads.set", dataset_id=traced, row_number=2, stage="sold")["ok"]
    assert not call(service, "leads.set", dataset_id=traced, row_number=2, callback_on="next week")["ok"]


def test_a_phone_number_is_placed_in_its_time_zone(service):
    zones = ok(service, "calling.zones", numbers=["+17135553142", "+12125553142", "not a number"])
    assert zones == {"+17135553142": ["America/Chicago"], "+12125553142": ["America/New_York"], "not a number": []}


def test_the_call_list_has_each_lead_worth_calling_once(service, tmp_path):
    rows = [*TRACED, ["JOHN SMITH", "12 Main Street", "Houston", "TX", "77008", "713-555-3142", ""], ["No Phone", "9 Elm St", "Houston", "TX", "77002", "", ""]]
    traced = add(service, tmp_path, "Traced", rows)
    assert not call(service, "export.prepare", kind="calls", dataset_id=traced)["ok"], "a list is checked before it is called"
    copy = checked(service, traced)
    ok(service, "leads.set", dataset_id=copy, row_number=3, stage="dead")
    ok(service, "leads.set", dataset_id=copy, row_number=4, stage="interested", callback_on="2026-10-20")
    ok(service, "leads.add_note", dataset_id=copy, row_number=4, note="Call after closing")
    made, out = export(service, kind="calls", dataset_id=copy, options={"columns": ["Email"]})
    assert made["filename"].endswith("(to call).csv") and made["left_out"] == {"no_number": 1, "repeats": 1, "stage": 1}
    assert [row["Name"] for row in out] == ["John Smith", "Wei Nguyen"]
    wei = out[1]
    assert (wei["Phone"], wei["Stage"], wei["Call back on"], wei["Latest note"], wei["Property Address"]) == ("+17135556600", "interested", "2026-10-20", "Call after closing", "305 Cedar Ln")
    assert out[0]["Email"] == "john@example.com"
    everyone = export(service, kind="calls", dataset_id=copy, options={"skip_stages": []})[1]
    assert [row["Name"] for row in everyone] == ["John Smith", "Maria Garcia", "Wei Nguyen"]


def test_the_mail_list_has_each_owner_once_at_where_their_mail_goes(service, tmp_path):
    more = [["GARCIA MARIA", "88 Pine Rd", "Houston", "TX", "77008", "PO Box 9"], ["John A Smith", "12 Main St", "Houston", "TX", "77008", "12 MAIN ST."]]
    county = add(service, tmp_path, "County roll", [*COUNTY, *more])
    made, out = export(service, kind="mail", dataset_id=county)
    assert made["rows"] == 3 and made["left_out"]["repeats"] == 2, "the same owner at the same address, however it is spelled, gets one letter"
    maria = next(row for row in out if row["Name"] == "GARCIA MARIA")
    assert (maria["Mailing Address"], maria["Property Address"]) == ("PO Box 9", "40 Oak Avenue")
    assert [row["Name"] for row in export(service, kind="mail", dataset_id=county, options={"absentee_only": True})[1]] == ["GARCIA MARIA"]
    assert export(service, kind="mail", dataset_id=county, options={"absentee_only": True, "skip_po_boxes": True})[1] == []
    target = tmp_path / "letters.csv"
    assert ok(service, "export.save", token=made["token"], path=str(target))["saved"] and target.read_bytes().startswith(b"\xef\xbb\xbfName,")
    assert not call(service, "export.chunk", token="../../secrets", offset=0)["ok"]


def test_a_deleted_list_can_be_brought_back_with_everything_it_had(service, tmp_path):
    traced = add(service, tmp_path, "Traced", TRACED)
    other = add(service, tmp_path, "County roll", COUNTY)
    config = ok(service, "skiptrace.save_settings", dataset_id=traced, config=ok(service, "skiptrace.suggest", dataset_id=traced)["config"])
    ok(service, "dataset.trash", dataset_id=traced)
    assert [item["id"] for item in ok(service, "dataset.list")] == [other]
    assert [(item["name"], item["row_count"]) for item in ok(service, "dataset.trashed")] == [("Traced", 3)]
    # A deleted list no longer stands in the way of adding the same file.
    again = wait(service, ok(service, "dataset.import", path=str(tmp_path / "Traced.csv"), name="Traced again")["job_id"])["result"]
    assert again["dataset_id"]

    ok(service, "dataset.restore", dataset_id=traced)
    assert traced in [item["id"] for item in ok(service, "dataset.list")] and ok(service, "dataset.trashed") == []
    assert len(ok(service, "dataset.rows", dataset_id=traced)) == 3 and ok(service, "skiptrace.suggest", dataset_id=traced)["config"] == config

    ok(service, "dataset.trash", dataset_id=traced)
    assert ok(service, "dataset.purge", dataset_id=traced)["purged"] == [traced]
    assert ok(service, "dataset.trashed") == [] and ok(service, "dataset.rows", dataset_id=traced) == []
    assert not call(service, "dataset.restore", dataset_id=traced)["ok"]


def test_a_list_deleted_long_ago_is_let_go_when_the_project_opens(service, tmp_path):
    traced = add(service, tmp_path, "Traced", TRACED)
    ok(service, "dataset.trash", dataset_id=traced)
    with service.store._connection:
        service.store._connection.execute("UPDATE trashed_datasets SET deleted_at = '2026-01-01T00:00:00+00:00'")
    ok(service, "project.open", path=service.project["root_path"])
    assert ok(service, "dataset.trashed") == []


def test_a_backup_is_one_file_that_opens_as_the_project(service, tmp_path):
    traced = add(service, tmp_path, "Traced", TRACED)
    ok(service, "leads.add_note", dataset_id=traced, row_number=2, note="Keep me")
    made = run(service, "project.backup", path=str(tmp_path / "safe.zip"))
    assert made["files"] == 1 and Path(made["path"]).stat().st_size == made["size"]
    restored = tmp_path / "restored"
    with zipfile.ZipFile(made["path"]) as archive:
        archive.extractall(restored)
    ok(service, "project.open", path=str(restored))
    assert [item["name"] for item in ok(service, "dataset.list")] == ["Traced"]
    assert [item["note"] for item in ok(service, "leads.notes", dataset_id=traced, row_number=2)] == ["Keep me"]
    assert Path(run(service, "project.backup")["path"]).parent == restored / "backups"
    assert not call(service, "project.backup", path="relative.zip")["ok"]


def test_filters_are_kept_by_name_for_a_list(service, tmp_path):
    traced = add(service, tmp_path, "Traced", TRACED)
    ok(service, "filters.save", dataset_id=traced, name="Houston to call", filter={"flag": "once", "area": "Houston"})
    kept = ok(service, "filters.save", dataset_id=traced, name="houston  to call", filter={"flag": "callable"})
    assert kept == [{"name": "houston to call", "filter": {"flag": "callable"}}] and ok(service, "filters.list", dataset_id=traced) == kept
    assert ok(service, "filters.save", dataset_id=traced, name="Houston to call", filter=None) == []
    assert not call(service, "filters.save", dataset_id=traced, name=" ", filter={})["ok"]
