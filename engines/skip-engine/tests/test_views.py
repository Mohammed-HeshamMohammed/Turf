"""What the screens show of a long list, worked out by the service: the same answers the window gives for a short one."""

from __future__ import annotations

from helpers import ok
from test_combine import add
from test_service_skiptrace import run, service  # noqa: F401
from callerwhale_service import views

TODAY = "2026-10-14"


def test_marks_are_read_as_the_window_reads_them():
    """The cases of tests/marks behaviour: the check's own verdict, a known wrong number, do not call, and the
    person's marks laid on top (an expired do-not-call no longer counts)."""
    phones = ["Phone"]
    plain = {"Phone (verdict)": "unverified", "Phone (E.164)": "+17135553142", "Best phone": "+17135553142", "Best phone verdict": "unverified"}
    assert views.read_marks(plain, phones, {}, TODAY) == {"verdict": "unverified", "best": "+17135553142", "known_wrong": False, "do_not_call": False, "manual": None, "number": "+17135553142"}
    wrong = {"Phone (verdict)": "wrong", "Phone (why)": "Marked wrong number in March list", "Phone (E.164)": "+17135553142", "Best phone": ""}
    assert views.read_marks(wrong, phones, {}, TODAY) | {} == {"verdict": "wrong", "best": None, "known_wrong": True, "do_not_call": False, "manual": None, "number": "+17135553142"}
    dnc = {**plain, "Phone (why)": "Do not call: on a do-not-call list in Leads until 2027-01-01"}
    assert views.read_marks(dnc, phones, {}, TODAY)["do_not_call"] is True
    marked = {"+17135553142": {"mark": "do_not_call", "until": None}}
    assert views.read_marks(plain, phones, marked, TODAY) | {"number": None} == {"verdict": "wrong", "best": None, "known_wrong": False, "do_not_call": True, "manual": "do_not_call", "number": None}
    expired = {"+17135553142": {"mark": "do_not_call", "until": "2026-01-01"}}
    assert views.read_marks(plain, phones, expired, TODAY)["manual"] is None
    interested = {"+17135553142": {"mark": "interested"}}
    assert views.read_marks(plain, phones, interested, TODAY)["verdict"] == "corroborated"
    reached = {**plain, "Best phone verdict": "corroborated", "Phone (verdict)": "corroborated"}
    assert views.read_marks(reached, phones, {"+17135553142": {"mark": "wrong_number"}}, TODAY)["verdict"] == "suspicious"


def test_reach_and_status_keys_are_the_windows():
    assert views.status_key("  DNC until 10/07/2025:Not   interested ") == "dnc until [date]:not interested"
    context = {"phone_columns": ["Phone"], "email_columns": ["Email"], "mail_columns": ["Mail"], "status_column": "Status", "status_kinds": {"dnc": "do_not_call", "disco": "bad_number"}}
    assert views.reach_of({"Phone": "713-555-3142", "Status": "DNC"}, context, None) == "blocked"
    assert views.reach_of({"Phone": "713-555-3142", "Status": "Disco"}, context, None) == "blocked"
    assert views.reach_of({"Phone": "713-555-3142"}, context, None) == "phone"
    assert views.reach_of({"Phone": "713-555-3142"}, context, True) == "ready"
    assert views.reach_of({"Phone": "n/a", "Email": "ann@example.com"}, context, None) == "email"
    assert views.reach_of({"Mail": "PO Box 9"}, context, None) == "mail"
    assert views.reach_of({}, context, None) == "none"


ROWS = [
    ["Owner Name", "Property Address", "City", "State", "Zip", "Phone"],
    ["John Smith", "12 Main St", "Houston", "TX", "77008", "(713) 555-3142"],
    ["Maria Garcia", "40 Oak Ave", "Houston", "TX", "77008", "713-555-8877"],
    ["Wei Nguyen", "305 Cedar Ln", "Austin", "TX", "78704", ""],
    ["JOHN SMITH", "12 Main Street", "Houston", "TX", "77008", "713-555-3142"],
]
AREAS = {"state": "State", "city": "City", "zip": "Zip"}
REACH = {"phone_columns": ["Phone"], "email_columns": [], "mail_columns": ["Property Address"], "status_column": None, "status_kinds": {}}


def checked(svc, tmp_path) -> str:
    dataset = add(svc, tmp_path, "Leads", ROWS)
    config = {**ok(svc, "skiptrace.suggest", dataset_id=dataset)["config"], "name_column": "Owner Name", "address_column": "Property Address"}
    return run(svc, "skiptrace.apply", dataset_id=dataset, config=config)["dataset_id"]


def test_a_long_lists_counts_come_from_the_service(service, tmp_path):
    copy = checked(service, tmp_path)
    summary = ok(service, "views.summary", dataset_id=copy, areas=AREAS, reach=REACH)
    assert summary["count"] == 4 and summary["checked"] and summary["callable"] == 3
    assert summary["flags"]["repeat"] == 1 and summary["flags"]["once"] == 3 and summary["flags"]["callable"] == 3
    assert summary["reach"] == {"ready": 3, "mail": 1}
    assert summary["coverage"] == {"phone": 3, "severalPhones": 0, "email": 0, "neither": 1}
    assert summary["areas"]["city"] == [{"name": "Houston", "count": 3}, {"name": "Austin", "count": 1}]
    assert sorted((place["zip"], place["count"]) for place in summary["places"]) == [("77008", 3), ("78704", 1)]
    assert "Best phone" in summary["columns"] and summary["zipless"] == 0


def test_a_long_list_is_read_a_filtered_page_at_a_time(service, tmp_path):
    copy = checked(service, tmp_path)

    def numbers(**filter_):
        return [row["row_number"] for row in ok(service, "views.page", dataset_id=copy, areas=AREAS, reach=REACH, filter=filter_, offset=0, limit=50)["rows"]]

    assert numbers() == [2, 3, 4, 5]
    assert numbers(flag="once") == [2, 3, 4] and numbers(flag="repeat") == [5] and numbers(flag="callable") == [2, 3, 5]
    assert numbers(level="city", area="Austin") == [4]
    assert numbers(query="garcia") == [3], "a word in a value of the list's own"
    assert numbers(query="city") == [], "not a column's name"
    assert numbers(query="verdict") == [], "nor a phone check's results"
    assert numbers(column="Property Address", contains="main") == [2, 5]
    assert numbers(column="Property Address", contains="main", flag="once") == [2]
    page = ok(service, "views.page", dataset_id=copy, areas=AREAS, reach=REACH, filter={}, offset=1, limit=2)
    assert page["total"] == 4 and [row["row_number"] for row in page["rows"]] == [3, 4] and page["rows"][0]["raw"]["Owner Name"] == "Maria Garcia"

    # A manual mark is laid on at once: the counts are made again.
    ok(service, "marks.set", number="+17135558877", mark="do_not_call")
    assert numbers(flag="dnc") == [3] and ok(service, "views.summary", dataset_id=copy, areas=AREAS, reach=REACH)["callable"] == 2
