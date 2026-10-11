"""Regression coverage for complete mapping, evidence, exact previews, and safe saves."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from threading import Event

import pytest

from helpers import call, ok, wait
from test_service_skiptrace import FILE_A, FILE_B, confirmed, make_dataset, run, service  # noqa: F401
from turf_service import skiptrace


def test_every_status_can_be_mapped_and_ignored_meanings_stay_ignored(service, tmp_path):
    rows = [["Person", str(i), "7135553142", "", "77009", "TX", f"Status {i}"] for i in range(101)]
    dataset = make_dataset(service, tmp_path, "Many statuses", rows)
    table = ok(service, "skiptrace.statuses", dataset_id=dataset, column="Status")
    assert len(table) == 101 and all(item["key"] for item in table)
    config = ok(service, "skiptrace.suggest", dataset_id=dataset)["config"]
    config["outcome"] = {"column": "Status", "called_column": "Phone", "map": {"status 100": ["wrong_number"], "status 0": []}}
    ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)
    statuses = {item["key"]: item for item in ok(service, "skiptrace.suggest", dataset_id=dataset)["statuses"]}
    assert statuses["status 100"]["outcomes"] == ["wrong_number"]
    assert statuses["status 0"]["outcomes"] == [] and statuses["status 0"]["confirmed"]
    assert not statuses["status 1"]["confirmed"]


def test_samples_keep_zero_values_and_do_not_change_rows(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Samples", FILE_A)
    before = ok(service, "dataset.rows", dataset_id=dataset)
    suggested = ok(service, "skiptrace.suggest", dataset_id=dataset)
    assert suggested["column_samples"]["Phone"] == [row[2] for row in FILE_A[:3]]
    assert ok(service, "dataset.rows", dataset_id=dataset) == before
    assert skiptrace._samples([{"Phone": 0}, {"Phone": 1}], ["Phone"])["Phone"] == ["0", "1"]


def test_manual_wrong_and_dnc_propagate_but_called_is_not_reached(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Manual targets", FILE_B)
    config = confirmed(service, dataset)
    ok(service, "marks.set", number="+17135556677", mark="wrong_number")
    ok(service, "marks.set", number="+17135558899", mark="do_not_call", until=(date.today() + timedelta(days=1)).isoformat())
    ok(service, "marks.set", number="+17135559090", mark="called")
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert report["verdicts"] == {"wrong": 2, "suspicious": 0, "unverified": 1, "corroborated": 0}
    assert report["row_counts"]["known_wrong"] == 1 and report["row_counts"]["dnc"] == 1
    text = " ".join(example["text"] for reason in report["reasons"] for example in reason["examples"])
    assert "Turf manual mark" in text and datetime.now(timezone.utc).date().isoformat() in text, "marks are stamped in UTC"


def test_manual_interest_and_wrong_conflict_keeps_sources_and_dnc_still_blocks(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Conflicts", [FILE_A[-1]])
    config = confirmed(service, dataset)
    config["outcome"]["map"] = {"interested": ["reached"]}
    ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)
    number = "+17135552211"
    ok(service, "marks.set", number=number, mark="wrong_number")
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert report["verdicts"]["suspicious"] == 1
    reason = next(item for item in report["reasons"] if item["code"] == "conflicting_outcomes")
    assert "Turf manual mark" in reason["examples"][0]["text"] and "this file" in reason["examples"][0]["text"]
    ok(service, "marks.set", number=number, mark="do_not_call")
    assert run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]["verdicts"]["wrong"] == 1


def test_manual_interest_corrobates_and_expired_dnc_does_not_block(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Expiry", FILE_B)
    config = confirmed(service, dataset)
    ok(service, "marks.set", number="+17135556677", mark="interested")
    ok(service, "marks.set", number="+17135558899", mark="do_not_call", until=(date.today() - timedelta(days=1)).isoformat())
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert report["verdicts"]["corroborated"] == 1 and report["verdicts"]["wrong"] == 0
    assert report["outcomes"]["expired_do_not_call_numbers"] == 1
    assert any(item["code"] == "dnc_expired" for item in report["reasons"])


def test_manual_history_survives_removal_and_projects_are_isolated(service, tmp_path):
    number = "+17135553142"
    first_path = service.project["root_path"]
    ok(service, "marks.set", number=number, mark="wrong_number")
    ok(service, "marks.set", number=number, mark="do_not_call", until="2030-01-01")
    ok(service, "marks.set", number=number, mark=None)
    assert ok(service, "marks.list") == {}
    assert [row["mark"] for row in ok(service, "marks.history")] == [None, "do_not_call", "wrong_number"]
    ok(service, "marks.set", number=number, mark="called")
    ok(service, "project.create", path=str(tmp_path / "second-project"), name="Second")
    assert ok(service, "marks.list") == {} and ok(service, "marks.history") == []
    ok(service, "project.open", path=first_path)
    assert ok(service, "marks.list")[number]["mark"] == "called"


def test_legacy_import_keeps_dates_and_never_overwrites_project_marks(service):
    number = "+17135553142"
    ok(service, "marks.set", number=number, mark="called")
    legacy = {number: {"mark": "wrong_number", "at": "2025-01-01T00:00:00Z"}, "+17135554455": {"mark": "do_not_call", "at": "2025-02-01T00:00:00Z"}}
    current = ok(service, "marks.import_legacy", marks=legacy)
    assert current[number]["mark"] == "called"
    assert current["+17135554455"]["at"] == legacy["+17135554455"]["at"]
    assert current["+17135554455"]["source"] == "Imported computer mark"
    ok(service, "marks.import_legacy", marks=legacy)
    assert len(ok(service, "marks.history")) == 2


def test_preview_review_and_saved_copy_are_identical_and_old_copies_remain(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, "Copies", FILE_A)
    config = confirmed(service, dataset)
    original = ok(service, "dataset.rows", dataset_id=dataset)
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    reviewed = ok(service, "skiptrace.review", job_id=report["scan_job_id"], limit=100)
    assert reviewed["rows"] == report["preview"]
    def forbidden(*args, **kwargs):
        raise AssertionError("Saving the reviewed scan must not re-evaluate")
    monkeypatch.setattr(skiptrace.engine, "evaluate", forbidden)
    first = run(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"], name="Checked once")
    second = run(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"], name="Checked twice")
    stored = ok(service, "dataset.rows", dataset_id=second["dataset_id"], limit=100)
    assert [{"row_number": row["row_number"], "raw": row["raw"]} for row in stored] == reviewed["rows"]
    copies = [row for row in ok(service, "dataset.list") if row["parent_dataset_id"] == dataset]
    assert [row["id"] for row in copies] == [second["dataset_id"], first["dataset_id"]]
    assert ok(service, "dataset.rows", dataset_id=dataset) == original
    for before, after in zip(original, stored):
        assert all(after["raw"][key] == value for key, value in before["raw"].items())
    assert len(second["added_columns"]) == 21
    assert {"Phone choices", "Phone evidence warnings", "Best phone quality", "Best phone permission"} <= set(second["added_columns"])


@pytest.mark.parametrize("change", ["manual", "other_setup", "date", "config"])
def test_changed_evidence_date_or_config_cannot_save_an_old_preview(service, tmp_path, monkeypatch, change):
    dataset = make_dataset(service, tmp_path, "Freshness", FILE_A)
    other = make_dataset(service, tmp_path, "Other", FILE_B)
    config = confirmed(service, dataset)
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    if change == "manual":
        ok(service, "marks.set", number="+17135553142", mark="do_not_call")
    elif change == "other_setup":
        confirmed(service, other)
    elif change == "config":
        config["signals"]["business_line"] = not config["signals"]["business_line"]
    else:
        class Tomorrow(date):
            @classmethod
            def today(cls):
                return date.today() + timedelta(days=1)
        monkeypatch.setattr(skiptrace, "date", Tomorrow)
    job = wait(service, ok(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"])["job_id"])
    assert job["state"] == "failed" and ("changed" in job["error"] or "out of date" in job["error"])
    assert not any(row["kind"] == "checked" for row in ok(service, "dataset.list"))


def test_review_filters_use_rows_and_keep_alternative_phones(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "Alternative", [FILE_A[0], FILE_A[1], FILE_A[-1]])
    config = confirmed(service, dataset)
    ok(service, "marks.set", number="+17135553142", mark="wrong_number")
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    assert report["row_counts"]["callable"] == 2 and report["row_counts"]["known_wrong"] == 1
    bad = ok(service, "skiptrace.review", job_id=report["scan_job_id"], filter="known_wrong")
    assert bad["total"] == 1 and bad["rows"][0]["raw"]["Best phone"] == "+17135554455"
    for filter_, total in report["row_counts"].items():
        assert ok(service, "skiptrace.review", job_id=report["scan_job_id"], filter=filter_)["total"] == total
    assert ok(service, "skiptrace.review", job_id=report["scan_job_id"], row_number=3)["rows"][0]["row_number"] == 3


def test_cancelling_a_scan_is_observed_inside_evaluation_and_leaves_no_output(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, "Cancel scan", FILE_A * 100)
    config = confirmed(service, dataset)
    entered, release = Event(), Event()
    original = skiptrace.engine.evaluate
    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(skiptrace.engine, "evaluate", blocked)
    job_id = ok(service, "skiptrace.scan", dataset_id=dataset, config=config)["job_id"]
    assert entered.wait(5)
    ok(service, "job.cancel", job_id=job_id)
    release.set()
    assert wait(service, job_id)["state"] == "cancelled"
    assert service.store._connection.execute("SELECT COUNT(*) FROM skiptrace_scan_rows").fetchone()[0] == 0
    assert len(ok(service, "dataset.list")) == 1


def test_cancelling_during_publication_rolls_back_every_checked_row(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, "Cancel save", FILE_A)
    config = confirmed(service, dataset)
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    entered, release = Event(), Event()
    register = skiptrace._register_rows
    def blocked(*args, **kwargs):
        result = register(*args, **kwargs)
        entered.set()
        assert release.wait(5)
        return result
    monkeypatch.setattr(skiptrace, "_register_rows", blocked)
    job_id = ok(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"])["job_id"]
    assert entered.wait(5)
    ok(service, "job.cancel", job_id=job_id)
    release.set()
    assert wait(service, job_id)["state"] == "cancelled"
    assert len(ok(service, "dataset.list")) == 1
    assert service.store._connection.execute("SELECT COUNT(*) FROM source_rows").fetchone()[0] == len(FILE_A)


def test_invalid_manual_edits_are_refused_without_losing_evidence(service):
    for payload in [{"number": "bad", "mark": "called"}, {"number": "+17135553142", "mark": "reached"},
                    {"number": "+17135553142", "mark": "called", "until": "2030-01-01"},
                    {"number": "+17135553142", "mark": "do_not_call", "until": "invalid"}]:
        assert not call(service, "marks.set", **payload)["ok"]
    assert ok(service, "marks.history") == []


def test_reimporting_legacy_marks_does_not_resurrect_a_removed_mark(service):
    number = "+17135553142"
    legacy = {number: {"mark": "wrong_number", "at": "2025-01-01T00:00:00Z"}}
    ok(service, "marks.import_legacy", marks=legacy)
    ok(service, "marks.set", number=number, mark=None)
    assert ok(service, "marks.import_legacy", marks=legacy) == {}
    assert len(ok(service, "marks.history")) == 2


def test_explicitly_choosing_no_outcomes_is_preserved(service, tmp_path):
    dataset = make_dataset(service, tmp_path, "No outcomes", FILE_A)
    config = confirmed(service, dataset)
    config["outcome"] = None
    ok(service, "skiptrace.save_settings", dataset_id=dataset, config=config)
    setup = ok(service, "skiptrace.suggest", dataset_id=dataset)
    assert setup["outcome_column"] is None and setup["statuses"] == []


def test_checked_copy_preserves_column_mapping_and_mapping_failure_is_atomic(service, tmp_path, monkeypatch):
    from turf_service.datasets import confirm_mapping, latest_mapping
    dataset = make_dataset(service, tmp_path, "Mapped", FILE_A)
    config = confirmed(service, dataset)
    confirm_mapping(service.store, dataset, {"Phone": "phone", "First Name": "first_name"})
    report = run(service, "skiptrace.scan", dataset_id=dataset, config=config)["report"]
    result = run(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"])
    assert latest_mapping(service.store, result["dataset_id"])["mapping_json"] == latest_mapping(service.store, dataset)["mapping_json"]
    before = len(ok(service, "dataset.list"))
    def broken_mapping(*args, **kwargs):
        raise ValueError("Mapping save failed")
    monkeypatch.setattr(skiptrace, "confirm_mapping", broken_mapping)
    job = wait(service, ok(service, "skiptrace.apply", dataset_id=dataset, config=config, scan_job_id=report["scan_job_id"])["job_id"])
    assert job["state"] == "failed" and "Mapping save failed" in job["error"]
    assert len(ok(service, "dataset.list")) == before
