"""Working leads day to day: a call recorded with the follow-up it calls for, a lead's history and the project's
recent activity, changing many leads at once, how the calls have gone, and finding anything in every list.

Caller Whale's own, after what a CRM such as EspoCRM offers: its stream, its call-center dashboard, mass update, workflow
rules and global search, cut down to a single person working lead lists on one computer.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from datetime import date, datetime, timedelta

from . import leads, phone_evidence
from .storage import ProjectStore, utc_now

_RULES = "leads.follow_up_rules"
DEFAULT_RULES = {"after_no_answer_days": 2, "after_voicemail_days": 3, "close_after_misses": 0}
_MISSES = ("no_answer", "voicemail")


# ------------------------------------------------------------------------------------------- follow-up rules

def rules(store: ProjectStore) -> dict:
    row = store._connection.execute("SELECT value_json FROM project_settings WHERE key = ?", (_RULES,)).fetchone()
    return {**DEFAULT_RULES, **(json.loads(row["value_json"]) if row else {})}


def set_rules(store: ProjectStore, payload: dict) -> dict:
    """What happens by itself after a call: a callback some days after no answer or a voicemail (0 for none), and a
    lead closed as dead after so many calls in a row without reaching anyone (0 never)."""
    changed = rules(store)
    for key in DEFAULT_RULES:
        if key in payload:
            value = int(payload[key])
            if not 0 <= value <= 365:
                raise ValueError("Use a number of days or calls from 0 to 365")
            changed[key] = value
    with store._connection:
        store._connection.execute(
            "INSERT INTO project_settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            (_RULES, json.dumps(changed, sort_keys=True), utc_now()),
        )
    return changed


def _misses_in_a_row(store: ProjectStore, numbers: set[str]) -> int:
    """Calls to these numbers since one last reached anyone."""
    count = 0
    for row in store._connection.execute(
        f"SELECT outcome FROM phone_outcomes WHERE retired_at IS NULL AND number IN ({','.join('?' * len(numbers))}) ORDER BY occurred_at DESC, recorded_at DESC", tuple(numbers)
    ):
        if row["outcome"] not in _MISSES:
            break
        count += 1
    return count


def record_call(store: ProjectStore, payload: dict) -> dict:
    """Records how a call to one of a row's numbers went, then does what the follow-up rules say: someone reached
    makes a new lead contacted; no answer or a voicemail sets a callback some days on, unless one is set already; so
    many misses in a row close the lead. Returns the lead's state and what the rules did, in words."""
    key, label, dataset_id, row_number = leads._lead(store, payload)
    recorded = phone_evidence.record(store, {"number": payload.get("number"), "outcome": payload.get("outcome"), "dataset_id": dataset_id,
                                             "row_number": row_number, "notes": payload.get("notes") or ""})
    current = store._connection.execute("SELECT * FROM lead_states WHERE lead_key = ?", (key,)).fetchone()
    stage = current["stage"] if current else "new"
    callback = current["callback_on"] if current else None
    outcome = recorded["outcome"]
    found = rules(store)
    change, did = {}, []
    if outcome == "reached" and stage == "new":
        change["stage"] = "contacted"
    if outcome in _MISSES:
        misses = _misses_in_a_row(store, {recorded["number"]})
        if found["close_after_misses"] and misses >= found["close_after_misses"] and stage not in ("dead", "not_interested", "interested"):
            change.update(stage="dead", callback_on=None)
            did.append(f"closed as dead after {misses} calls without an answer")
        else:
            days = found["after_no_answer_days" if outcome == "no_answer" else "after_voicemail_days"]
            if days and not (callback and callback[:10] >= date.today().isoformat()):
                on = (date.today() + timedelta(days=days)).isoformat()
                change.update(callback_on=on, callback_note="Try again" if outcome == "no_answer" else "Voicemail left; try again")
                did.append(f"call back on {on}")
    state = leads.apply(store, key, label, dataset_id, row_number, change, why="follow-up rule" if did else "") if change else (
        {"lead_key": key, **leads._state(current)} if current else {"lead_key": key, "stage": "new", "callback_on": None, "callback_note": ""})
    return {"call": recorded, "state": state, "rules": did}


# --------------------------------------------------------------------------------------- history and activity

def _names(store: ProjectStore) -> dict[str, str]:
    return {row["id"]: row["name"] for row in store._connection.execute("SELECT id, name FROM datasets")}


def history(store: ProjectStore, payload: dict) -> list[dict]:
    """Everything that happened to one lead, newest first: calls, notes, stage changes and callbacks."""
    key, _, dataset_id, row_number = leads._lead(store, payload)
    names = _names(store)
    items = []
    for row in store._connection.execute("SELECT * FROM lead_events WHERE lead_key = ?", (key,)):
        items.append({"at": row["at"], "kind": row["kind"], **json.loads(row["detail_json"]), "list": names.get(row["dataset_id"], "")})
    for row in store._connection.execute("SELECT note, at, dataset_id FROM lead_notes WHERE lead_key = ? AND removed_at IS NULL", (key,)):
        items.append({"at": row["at"], "kind": "note", "note": row["note"], "list": names.get(row["dataset_id"], "")})
    # Calls are kept per row: those of every row that is this lead, in any list whose leads are known.
    rows = {(dataset_id, row_number)}
    for other in {row["dataset_id"] for row in store._connection.execute("SELECT DISTINCT dataset_id FROM phone_outcomes WHERE dataset_id IS NOT NULL")}:
        try:
            keys = leads.of_list(store, other)["keys"]
        except ValueError:
            continue
        rows |= {(other, number) for number, lead in keys.items() if lead == key}
    for row in store._connection.execute("SELECT * FROM phone_outcomes WHERE retired_at IS NULL AND dataset_id IS NOT NULL"):
        if (row["dataset_id"], row["row_number"]) in rows:
            items.append({"at": row["recorded_at"], "kind": "call", "outcome": row["outcome"], "number": row["number"], "note": row["notes"] or "", "list": names.get(row["dataset_id"], "")})
    return sorted(items, key=lambda item: item["at"], reverse=True)[:200]


def activity(store: ProjectStore, project_id: str, limit: int = 30) -> list[dict]:
    """What happened lately across the project's leads, newest first: calls, notes, stage changes, callbacks."""
    here = {row["id"]: row["name"] for row in store._connection.execute("SELECT id, name FROM datasets WHERE project_id = ?", (project_id,))}
    labels = {row["lead_key"]: row["label"] for row in store._connection.execute("SELECT lead_key, label FROM lead_states")}
    limit = max(1, min(int(limit), 200))
    items = []
    for row in store._connection.execute("SELECT * FROM lead_events ORDER BY at DESC LIMIT ?", (limit * 2,)):
        if row["dataset_id"] in here:
            items.append({"at": row["at"], "kind": row["kind"], **json.loads(row["detail_json"]), "label": labels.get(row["lead_key"], ""), "list": here[row["dataset_id"]],
                          "dataset_id": row["dataset_id"], "row_number": row["row_number"]})
    for row in store._connection.execute("SELECT * FROM lead_notes WHERE removed_at IS NULL ORDER BY at DESC LIMIT ?", (limit,)):
        if row["dataset_id"] in here:
            items.append({"at": row["at"], "kind": "note", "note": row["note"], "label": labels.get(row["lead_key"], ""), "list": here[row["dataset_id"]],
                          "dataset_id": row["dataset_id"], "row_number": row["row_number"]})
    for row in store._connection.execute("SELECT * FROM phone_outcomes WHERE retired_at IS NULL ORDER BY recorded_at DESC LIMIT ?", (limit,)):
        if row["dataset_id"] in here:
            items.append({"at": row["recorded_at"], "kind": "call", "outcome": row["outcome"], "number": row["number"], "label": "", "list": here[row["dataset_id"]],
                          "dataset_id": row["dataset_id"], "row_number": row["row_number"]})
    return sorted(items, key=lambda item: item["at"], reverse=True)[:limit]


# ----------------------------------------------------------------------------------------- many at once

def set_many(store: ProjectStore, payload: dict) -> dict:
    """The same change for many rows of a list: a stage, a callback, or both. Each lead is changed once, however
    many of the rows are that lead."""
    dataset_id = str(payload["dataset_id"])
    numbers = [int(number) for number in payload.get("row_numbers") or []]
    if not numbers:
        raise ValueError("Choose the rows first")
    if len(numbers) > 50_000:
        raise ValueError("Change up to 50,000 rows at once")
    change = {name: payload[name] for name in ("stage", "callback_on", "callback_note") if name in payload}
    if not change:
        raise ValueError("Say what to change")
    found = leads.of_list(store, dataset_id)
    seen: set[str] = set()
    for number in numbers:
        key = found["keys"].get(number)
        if key is None or key in seen:
            continue
        seen.add(key)
        leads.apply(store, key, found["labels"][number], dataset_id, number, change)
    return {"leads": len(seen)}


# ---------------------------------------------------------------------------------------------- call stats

def call_stats(store: ProjectStore, project_id: str, days: int = 14, today: str | None = None) -> dict:
    """How the calls have gone: each of the last days with its calls by outcome, and totals for today, the last
    seven days and all the days shown. A day is this computer's day."""
    today_day = date.fromisoformat(today) if today else date.today()
    days = max(1, min(int(days), 90))
    first = today_day - timedelta(days=days - 1)
    # Every call of the project counts, whether it was recorded on a list's row or in the project's call log.
    del project_id
    per_day: dict[str, Counter] = {(first + timedelta(days=offset)).isoformat(): Counter() for offset in range(days)}
    for row in store._connection.execute("SELECT outcome, recorded_at FROM phone_outcomes WHERE retired_at IS NULL"):
        local = datetime.fromisoformat(row["recorded_at"]).astimezone().date().isoformat() if row["recorded_at"] else ""
        if local in per_day:
            per_day[local][row["outcome"]] += 1
    week = (today_day - timedelta(days=6)).isoformat()
    total = sum((counts for counts in per_day.values()), Counter())
    last_week = sum((counts for day, counts in per_day.items() if day >= week), Counter())
    calls = sum(total.values())
    return {
        "days": [{"day": day, "calls": sum(counts.values()), "outcomes": dict(counts)} for day, counts in per_day.items()],
        "today": sum(per_day[today_day.isoformat()].values()), "week": sum(last_week.values()), "calls": calls,
        "outcomes": dict(total), "reached_share": round(total["reached"] / calls, 4) if calls else None,
    }


# ---------------------------------------------------------------------------------------------- search

_DIGITS = re.compile(r"\D")


def search(store: ProjectStore, project_id: str, query: object, limit: int = 30) -> list[dict]:
    """Rows in any list of the project that hold the words, or the phone number, searched for: a caller's number, an
    owner's name, a street. A checked copy is its list's rows again, so only the lists themselves are searched."""
    text = " ".join(str(query or "").split()).lower()
    if len(text) < 3:
        return []
    digits = _DIGITS.sub("", text)
    by_phone = len(digits) >= 7 and len(digits) >= len(text.replace(" ", "")) - 4
    lists = {row["id"]: dict(row) for row in store._connection.execute("SELECT id, name, kind, parent_dataset_id FROM datasets WHERE project_id = ?", (project_id,))}
    wanted = [dataset_id for dataset_id, item in lists.items() if not (item["kind"] == "checked" and item["parent_dataset_id"] in lists)]
    if not wanted:
        return []
    marks = ",".join("?" * len(wanted))
    # The database narrows the rows; each is then read to be sure the match is in a value, not a column's name.
    if by_phone:
        clause, args = "raw_values_json LIKE ?", (f"%{digits[-4:]}%",)
    else:
        clause, args = " AND ".join("lower(raw_values_json) LIKE ?" for _ in text.split()), tuple(f"%{word}%" for word in text.split())
    found = []
    for row in store._connection.execute(f"SELECT dataset_id, source_row_number, raw_values_json FROM source_rows WHERE dataset_id IN ({marks}) AND {clause}", (*wanted, *args)):
        raw = json.loads(row["raw_values_json"])
        values = [str(value) for value in raw.values() if value not in (None, "")]
        if by_phone:
            tail = digits[-10:]
            if not any(len(_DIGITS.sub("", value)) >= 7 and _DIGITS.sub("", value).endswith(tail) for value in values):
                continue
        elif not all(any(word in value.lower() for value in values) for word in text.split()):
            continue
        found.append({"dataset_id": row["dataset_id"], "list": lists[row["dataset_id"]]["name"], "row_number": row["source_row_number"], "label": " · ".join(values[:4])[:160]})
        if len(found) >= max(1, min(int(limit), 100)):
            break
    return found

