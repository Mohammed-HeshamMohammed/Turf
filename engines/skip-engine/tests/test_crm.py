"""Working leads day to day: follow-up rules after a call, a lead's history, the project's activity, many leads at
once, call statistics and searching every list."""

from __future__ import annotations

from datetime import date, timedelta

from helpers import call, ok
from test_combine import COUNTY, TRACED, add
from test_service_skiptrace import service  # noqa: F401


def lists(svc, tmp_path):
    return add(svc, tmp_path, "Traced", TRACED), add(svc, tmp_path, "County roll", COUNTY)


def test_a_call_without_an_answer_sets_a_callback_and_misses_close_a_lead(service, tmp_path):
    traced, _ = lists(service, tmp_path)
    assert ok(service, "leads.rules") == {"after_no_answer_days": 2, "after_voicemail_days": 3, "close_after_misses": 0}
    first = ok(service, "leads.record_call", dataset_id=traced, row_number=2, number="+17135553142", outcome="no_answer")
    in_two = (date.today() + timedelta(days=2)).isoformat()
    assert first["state"]["callback_on"] == in_two and first["rules"] == [f"call back on {in_two}"] and first["call"]["outcome"] == "no_answer"
    # A callback already set is left alone.
    assert ok(service, "leads.record_call", dataset_id=traced, row_number=2, number="+17135553142", outcome="voicemail")["rules"] == []

    ok(service, "leads.set_rules", close_after_misses=3)
    third = ok(service, "leads.record_call", dataset_id=traced, row_number=2, number="+17135553142", outcome="no_answer")
    assert third["state"]["stage"] == "dead" and third["state"]["callback_on"] is None and third["rules"] == ["closed as dead after 3 calls without an answer"]

    reached = ok(service, "leads.record_call", dataset_id=traced, row_number=3, number="+17135558877", outcome="reached")
    assert reached["state"]["stage"] == "contacted" and reached["rules"] == []
    assert not call(service, "leads.set_rules", after_no_answer_days=400)["ok"]


def test_a_lead_has_a_history_and_the_project_an_activity_feed(service, tmp_path):
    traced, county = lists(service, tmp_path)
    ok(service, "leads.record_call", dataset_id=traced, row_number=2, number="+17135553142", outcome="reached")
    ok(service, "leads.set", dataset_id=traced, row_number=2, stage="interested", callback_on="2026-10-20T15:30", callback_note="offer")
    ok(service, "leads.add_note", dataset_id=traced, row_number=2, note="Wants $240k")
    # The county roll's row is the same property: the same lead, with the same history.
    kinds = [(item["kind"], item.get("to") or item.get("outcome") or item.get("on") or item.get("note")) for item in ok(service, "leads.history", dataset_id=county, row_number=2)]
    assert sorted(kinds) == sorted([("note", "Wants $240k"), ("callback", "2026-10-20T15:30"), ("stage", "interested"), ("stage", "contacted"), ("call", "reached")])
    feed = ok(service, "leads.activity", limit=10)
    assert {item["kind"] for item in feed} == {"note", "callback", "stage", "call"} and all(item["list"] == "Traced" for item in feed)
    due = ok(service, "leads.due", today="2026-10-20")["due"]
    assert [(item["on"], item["time"]) for item in due] == [("2026-10-20T15:30", "15:30")], "a callback with a time is due on its day"


def test_many_leads_are_changed_at_once_each_once(service, tmp_path):
    rows = [*TRACED, ["JOHN SMITH", "12 Main Street", "Houston", "TX", "77008", "713-555-3142", ""]]
    traced = add(service, tmp_path, "Traced", rows)
    assert ok(service, "leads.set_many", dataset_id=traced, row_numbers=[2, 3, 5], stage="interested", callback_on="2026-10-21")["leads"] == 2
    states = ok(service, "leads.for_list", dataset_id=traced)
    assert {states["states"][states["keys"][number]]["stage"] for number in ("2", "3", "5")} == {"interested"}
    assert states["keys"]["4"] not in states["states"]
    assert not call(service, "leads.set_many", dataset_id=traced, row_numbers=[], stage="dead")["ok"]
    assert not call(service, "leads.set_many", dataset_id=traced, row_numbers=[2])["ok"]


def test_call_statistics_count_the_calls_of_each_day(service, tmp_path):
    traced, _ = lists(service, tmp_path)
    for number, outcome in (("+17135553142", "no_answer"), ("+17135553142", "reached"), ("+17135558877", "voicemail")):
        ok(service, "phone.record_outcome", number=number, outcome=outcome)
    stats = ok(service, "calls.stats", days=7)
    assert stats["today"] == 3 and stats["week"] == 3 and stats["calls"] == 3 and stats["reached_share"] == round(1 / 3, 4)
    assert stats["outcomes"] == {"no_answer": 1, "reached": 1, "voicemail": 1} and len(stats["days"]) == 7 and stats["days"][-1]["calls"] == 3
    del traced


def test_everything_is_searched_by_words_or_by_a_phone_number(service, tmp_path):
    lists(service, tmp_path)
    by_phone = ok(service, "search.everywhere", query="713.555.3142")
    assert [(item["list"], item["row_number"]) for item in by_phone] == [("Traced", 2)]
    by_name = ok(service, "search.everywhere", query="smith john")
    assert sorted((item["list"], item["row_number"]) for item in by_name) == [("County roll", 2), ("Traced", 2)]
    assert ok(service, "search.everywhere", query="owner") == [], "a column's name is not a match"
    assert ok(service, "search.everywhere", query="ab") == []
