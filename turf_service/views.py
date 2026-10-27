"""What the screens show of a long list, worked out here instead of in the window.

Turf's own. A list of up to LARGE rows is read whole into the window, which then counts, filters and maps it by
itself (src/lib). A longer one would hold the window still and fill its memory, so for it the window asks for what
it shows: the counts and areas of the list (`summary`), and one page of rows at a time, filtered (`page`).

The rules are the window's, written again here: the marks a phone check left on a row (marks.ts, `readMarks`), how
a row can be reached (dashboard.ts, `reachOf`) and a call status's key (dashboard.ts, `statusKey`). The tests hold
the two to the same answers. One thing differs: an email counts as a way to reach someone without its domain being
looked up, since that is done for a few thousand addresses, not hundreds of thousands.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import date

from .manual import list_marks
from .storage import ProjectStore

# Lists longer than this are shown through this module. Below it the window is quick enough on its own.
LARGE = 50_000
_RANK = {"corroborated": 0, "unverified": 1, "suspicious": 2, "wrong": 3}
VERDICTS = tuple(_RANK)
_ADDED = re.compile(r"\((verdict|why|E\.164|type|quality|permission)\)$")
_ADDED_NAMES = {"Phone choices", "Phone evidence warnings", "Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows"}
_WRONG = re.compile(r"marked wrong number (in|\d)", re.IGNORECASE)
_REACHED = re.compile(r"but reached", re.IGNORECASE)
_DNC = re.compile(r"do not call: on a do-not-call list", re.IGNORECASE)
_DATE_AFTER_UNTIL = re.compile(r"\b(until|till|through|thru|expires?|exp)\s*:?\s*(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4})", re.IGNORECASE)
_EMAIL = re.compile(r"[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[a-z]{2,}", re.IGNORECASE)
_SPACE = re.compile(r"\s+")
FLAGS = ("callable", "wrong", "dnc", "manual", "repeat", "once", "possible")
_cache: dict[tuple, dict] = {}


def is_added(column: str) -> bool:
    return bool(_ADDED.search(column)) or column.startswith("Best phone") or column in _ADDED_NAMES


def status_key(value: object) -> str:
    text = _SPACE.sub(" ", "" if value is None else str(value)).strip()
    return _DATE_AFTER_UNTIL.sub(lambda match: f"{match.group(1).lower()} [date]", text).lower()


def read_marks(raw: dict, phone_columns: list[str], manual: dict, today: str) -> dict:
    """A row's verdict, whether it has a number to call, and its flags: marks.ts `readMarks`, line for line."""
    verdict = raw.get("Best phone verdict") if raw.get("Best phone verdict") in _RANK else None
    best_from = str(raw["Best phone from"]) if raw.get("Best phone from") else None
    best = str(raw["Best phone"]) if raw.get("Best phone") else None
    known_wrong = do_not_call = False
    first_number = None
    for column in phone_columns:
        column_verdict = raw.get(f"{column} (verdict)")
        if column_verdict in _RANK and (not verdict or (not raw.get("Best phone verdict") and _RANK[column_verdict] < _RANK[verdict])):
            verdict = column_verdict
            best_from = best_from if raw.get("Best phone from") else column
        if first_number is None and raw.get(f"{column} (E.164)"):
            first_number = str(raw[f"{column} (E.164)"])
        why = str(raw.get(f"{column} (why)") or "")
        if _WRONG.search(why) and not _REACHED.search(why):
            known_wrong = True
        if _DNC.search(why):
            do_not_call = True
    why = str(raw["Best phone why"]) if raw.get("Best phone why") else (str(raw.get(f"{best_from} (why)") or "") if best_from else "")
    number = ((best or first_number or "").split(";")[0].strip()) or None
    entry = manual.get(number) if number else None
    mark = entry["mark"] if entry else None
    if mark == "do_not_call" and entry.get("until") and entry["until"] < today:
        mark = None
    if mark == "wrong_number":
        verdict = "suspicious" if verdict == "corroborated" or _REACHED.search(why) else "wrong"
        known_wrong = verdict == "wrong"
    if mark == "do_not_call":
        verdict, do_not_call = "wrong", True
    if mark == "interested" and verdict != "wrong":
        verdict = "corroborated"
    usable = bool(raw.get("Best phone quality")) and raw.get("Best phone quality") != "wrong" and raw.get("Best phone permission") == "no_recorded_block"
    blocked = mark == "do_not_call" or (mark == "wrong_number" and verdict == "wrong")
    callable_ = None if blocked else (best if usable else (None if verdict == "wrong" else best))
    return {"verdict": verdict, "best": callable_, "known_wrong": known_wrong, "do_not_call": do_not_call, "manual": mark, "number": number}


def _digits(value: object) -> int:
    return sum(character.isdigit() for character in ("" if value is None else str(value)))


def reach_of(raw: dict, context: dict, callable_: bool | None) -> str:
    """How a row can be reached: dashboard.ts `reachOf`, with every email taken as usable."""
    kind = context["status_kinds"].get(status_key(raw.get(context["status_column"]))) if context.get("status_column") else None
    has_phone = any(_digits(raw.get(column)) >= 7 for column in context["phone_columns"])
    if kind == "do_not_call":
        return "blocked"
    if callable_ is not None and has_phone:
        return "ready" if callable_ else "blocked"
    if has_phone:
        return "blocked" if kind == "bad_number" else "phone"
    if any(_EMAIL.search(str(raw.get(column) or "")) for column in context["email_columns"]):
        return "email"
    if any(len(str(raw.get(column) or "").strip()) > 3 for column in context["mail_columns"]):
        return "mail"
    return "none"


def _rows(store: ProjectStore, dataset_id: str, where: str = "", args: tuple = ()):
    for row in store._connection.execute(f"SELECT id, source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ? {where} ORDER BY source_row_number", (dataset_id, *args)):
        yield row["id"], row["source_row_number"], json.loads(row["raw_values_json"])


def _clean_context(context: object) -> dict:
    context = context if isinstance(context, dict) else {}
    listed = lambda key: [str(item) for item in context.get(key) or []]  # noqa: E731
    return {"phone_columns": listed("phone_columns"), "email_columns": listed("email_columns"), "mail_columns": listed("mail_columns"),
            "status_column": context.get("status_column") or None, "status_kinds": {str(key): str(value) for key, value in (context.get("status_kinds") or {}).items()}}


def _index(store: ProjectStore, dataset_id: str, areas: dict, context: dict) -> dict:
    """One pass over the list: each row's marks and area, and every count the screens show. Kept while the list, the
    project's manual marks, the day, the area columns and the reach context stand; a list's rows never change."""
    manual = list_marks(store)
    today = date.today().isoformat()
    key = (str(store.database_path), dataset_id, today, hashlib.sha1(json.dumps([manual, areas, context], sort_keys=True).encode()).hexdigest())
    if key in _cache:
        return _cache[key]
    numbers: list[int] = []
    verdicts: list[str | None] = []
    flags: list[int] = []
    area_values: dict[str, list[str]] = {level: [] for level in ("state", "city", "zip") if areas.get(level)}
    columns: list[str] = []
    counts = {"verdicts": dict.fromkeys(VERDICTS, 0), "callable": 0, "flags": dict.fromkeys(FLAGS, 0), "reach": Counter(),
              "coverage": {"phone": 0, "severalPhones": 0, "email": 0, "neither": 0}, "zipless": 0}
    places: Counter = Counter()
    blocked: set[str] = set()
    phone_columns: list[str] | None = None
    for count, (_row_id, number, raw) in enumerate(_rows(store, dataset_id)):
        if phone_columns is None:
            columns = list(raw)
            phone_columns = [column[: -len(" (verdict)")] for column in columns if column.endswith(" (verdict)")]
        checked = bool(phone_columns)
        marks = read_marks(raw, phone_columns, manual, today)
        status = str(raw.get("Duplicate status") or "")
        bits = (
            (1 if marks["best"] else 0) | (2 if marks["known_wrong"] else 0) | (4 if marks["do_not_call"] else 0) | (8 if marks["manual"] else 0)
            | (16 if status.startswith("Duplicate of") else 0) | (32 if not status.startswith("Duplicate of") else 0) | (64 if status.startswith("Possible") else 0)
        )
        numbers.append(number)
        verdicts.append(marks["verdict"])
        flags.append(bits)
        if marks["verdict"]:
            counts["verdicts"][marks["verdict"]] += 1
        counts["callable"] += bool(marks["best"])
        for at, flag in enumerate(FLAGS):
            counts["flags"][flag] += bool(bits & (1 << at))
        if (marks["known_wrong"] or marks["do_not_call"]) and marks["number"]:
            blocked.add(marks["number"])
        counts["reach"][reach_of(raw, context, bool(marks["best"]) if checked else None)] += 1
        phones = sum(1 for column in context["phone_columns"] if _digits(raw.get(column)) >= 7)
        email = any("@" in str(raw.get(column) or "") for column in context["email_columns"])
        coverage = counts["coverage"]
        coverage["phone"] += phones > 0
        coverage["severalPhones"] += phones > 1
        coverage["email"] += email
        coverage["neither"] += not phones and not email
        for level, values in area_values.items():
            values.append(str(raw.get(areas[level]) or "").strip())
        zip_code = str(raw.get(areas["zip"]) or "").strip() if areas.get("zip") else ""
        counts["zipless"] += not zip_code
        places[(zip_code, str(raw.get(areas["city"]) or "").strip() if areas.get("city") else "", str(raw.get(areas["state"]) or "").strip() if areas.get("state") else "")] += 1
        del count
    made = {
        "numbers": numbers, "verdicts": verdicts, "flags": flags, "areas": area_values, "columns": columns,
        "summary": {
            "count": len(numbers), "columns": columns, "checked": bool(phone_columns), "verdicts": counts["verdicts"], "callable": counts["callable"],
            "flags": counts["flags"], "blocked_numbers": len(blocked), "reach": dict(counts["reach"]), "coverage": counts["coverage"], "zipless": counts["zipless"],
            "areas": {level: [{"name": name, "count": total} for name, total in sorted(Counter(value for value in values if value).items(), key=lambda item: (-item[1], item[0]))]
                      for level, values in area_values.items()},
            "places": [{"zip": zip_code, "city": city, "state": state, "count": total} for (zip_code, city, state), total in places.items()],
        },
    }
    while len(_cache) >= 4:
        _cache.pop(next(iter(_cache)))
    _cache[key] = made
    return made


def _areas(value: object) -> dict:
    value = value if isinstance(value, dict) else {}
    return {level: str(value[level]) for level in ("state", "city", "zip") if value.get(level)}


def summary(store: ProjectStore, payload: dict) -> dict:
    """The counts of a long list: verdicts, flags, how its rows can be reached, its areas and where they are."""
    return _index(store, str(payload["dataset_id"]), _areas(payload.get("areas")), _clean_context(payload.get("reach")))["summary"]


def page(store: ProjectStore, payload: dict) -> dict:
    """One page of a long list's rows, filtered as the Lists tab's filter bar says, and how many rows match."""
    dataset_id = str(payload["dataset_id"])
    areas = _areas(payload.get("areas"))
    found = _index(store, dataset_id, areas, _clean_context(payload.get("reach")))
    wanted = payload.get("filter") if isinstance(payload.get("filter"), dict) else {}
    keep = range(len(found["numbers"]))
    verdict = wanted.get("verdict")
    if verdict and verdict != "all":
        keep = [at for at in keep if found["verdicts"][at] == verdict]
    flag = wanted.get("flag")
    if flag in FLAGS:
        bit = 1 << FLAGS.index(flag)
        keep = [at for at in keep if found["flags"][at] & bit]
    level, area = wanted.get("level"), wanted.get("area")
    if area and level in found["areas"]:
        values = found["areas"][level]
        keep = [at for at in keep if values[at] == area]
    # Text: the database narrows the rows to those whose stored text holds the words, then each is read to make sure
    # the words are in a value of the list's own (not in a column's name, nor in a phone check's results).
    column, contains, query = str(wanted.get("column") or ""), str(wanted.get("contains") or "").strip().lower(), str(wanted.get("query") or "").strip().lower()
    own = [name for name in found["columns"] if not is_added(name)]
    if (column and contains) or query:
        needles = [needle for needle in (contains if column else "", query) if needle]
        where = " ".join("AND lower(raw_values_json) LIKE ? ESCAPE '\\'" for _ in needles)
        like = tuple("%" + json.dumps(needle)[1:-1].replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%" for needle in needles)
        matching = set()
        for _row_id, number, raw in _rows(store, dataset_id, where, like):
            if column and contains and contains not in str(raw.get(column) or "").lower():
                continue
            if query and not any(query in str(raw.get(name) or "").lower() for name in own):
                continue
            matching.add(number)
        keep = [at for at in keep if found["numbers"][at] in matching]
    keep = list(keep)
    offset, limit = max(0, int(payload.get("offset", 0))), max(1, min(int(payload.get("limit", 25)), 500))
    shown = [found["numbers"][at] for at in keep[offset:offset + limit]]
    rows = []
    if shown:
        marks = ",".join("?" * len(shown))
        from .images import for_screen
        rows = [{"id": row_id, "row_number": number, "raw": for_screen(store, raw)} for row_id, number, raw in _rows(store, dataset_id, f"AND source_row_number IN ({marks})", tuple(shown))]
    return {"total": len(keep), "rows": rows}
