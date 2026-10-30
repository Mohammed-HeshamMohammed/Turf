"""Working the leads: where each one stands, notes on it, when to call it again, and when it may be called.

Caller Whale's own. A lead is its property (street number, street, unit and ZIP), or its phone when the row has no address,
so a note or a stage follows the lead into every list of the project that holds it, whatever the list calls its
columns. A row with neither is a lead of its own.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from uuid import uuid4

import phonenumbers
from phonenumbers import timezone as phone_zones

from callerwhale_matching import duplicates

from .storage import ProjectStore, utc_now

STAGES = ("new", "contacted", "interested", "not_interested", "dead")
MAX_NOTE = 4000
# Each list's leads are worked out once and kept while the service runs: a list's rows never change.
_cache: dict[tuple, dict] = {}


def _config_of(store: ProjectStore, dataset: dict) -> dict:
    """What the columns are: a checked copy carries the setup it was checked with; a list has its own, or a guess."""
    from .combine import _config
    if dataset["kind"] == "checked":
        saved = json.loads(dataset["derivation_json"] or "{}").get("config")
        if saved:
            return saved
    return _config(store, dataset["id"], [json.loads(row["raw_values_json"]) for row in store._connection.execute(
        "SELECT raw_values_json FROM source_rows WHERE dataset_id = ? ORDER BY source_row_number LIMIT 400", (dataset["id"],))])


def lead_key(n: dict, dataset_id: str, row_number: int) -> str:
    address = n.get("address")
    if address and address["house_number"] and address["street"] and n.get("postal_code"):
        return f"a:{address['house_number']} {address['street']} {address['unit']}".rstrip() + f"|{n['postal_code']}"
    if n["phone"]:
        return "p:" + min(n["phone"])
    if n["email"]:
        return "e:" + min(n["email"])
    return f"r:{dataset_id}:{row_number}"


def of_list(store: ProjectStore, dataset_id: str) -> dict:
    """{"keys": {row number: lead}, "labels": {row number: a few words to know the lead by}} for a list."""
    dataset = store._connection.execute("SELECT * FROM datasets WHERE id = ?", (dataset_id,)).fetchone()
    if dataset is None:
        raise ValueError("This list is no longer in the project")
    dataset = dict(dataset)
    config = _config_of(store, dataset)
    cache_key = (str(store.database_path), dataset_id, json.dumps(config, sort_keys=True))
    if cache_key in _cache:
        return _cache[cache_key]
    found = store._connection.execute("SELECT source_row_number, raw_values_json FROM source_rows WHERE dataset_id = ? ORDER BY source_row_number", (dataset_id,)).fetchall()
    numbers = [row["source_row_number"] for row in found]
    rows = [json.loads(row["raw_values_json"]) for row in found]
    listed, mapping = duplicates.normalize_list(rows, config, rows if dataset["kind"] == "checked" else None)
    made = {
        "keys": {number: lead_key(n, dataset_id, number) for number, n in zip(numbers, listed)},
        "labels": {number: duplicates._label(row, mapping, n["phone"]) for number, row, n in zip(numbers, rows, listed)},
    }
    while len(_cache) >= 6:
        _cache.pop(next(iter(_cache)))
    _cache[cache_key] = made
    return made


def _state(row) -> dict:
    return {"stage": row["stage"], "callback_on": row["callback_on"], "callback_note": row["callback_note"], "updated_at": row["updated_at"]}


def for_list(store: ProjectStore, dataset_id: str) -> dict:
    """Every row's lead, and what is known about the leads of this list: stage, callback, how many notes."""
    keys = of_list(store, dataset_id)["keys"]
    wanted = set(keys.values())
    states = {row["lead_key"]: _state(row) for row in store._connection.execute("SELECT * FROM lead_states") if row["lead_key"] in wanted}
    notes: dict[str, int] = {}
    for row in store._connection.execute("SELECT lead_key, COUNT(*) AS notes FROM lead_notes WHERE removed_at IS NULL GROUP BY lead_key"):
        if row["lead_key"] in wanted:
            notes[row["lead_key"]] = row["notes"]
    return {"keys": {str(number): key for number, key in keys.items()}, "states": states, "notes": notes}


def get(store: ProjectStore, payload: dict) -> dict:
    """One row's lead and where it stands, without the rest of its list."""
    key = _lead(store, payload)[0]
    row = store._connection.execute("SELECT * FROM lead_states WHERE lead_key = ?", (key,)).fetchone()
    return {"lead_key": key, "state": _state(row) if row else None}


def _lead(store: ProjectStore, payload: dict) -> tuple[str, str, str, int]:
    dataset_id, row_number = str(payload["dataset_id"]), int(payload["row_number"])
    found = of_list(store, dataset_id)
    if row_number not in found["keys"]:
        raise ValueError("That row is not in the list")
    return found["keys"][row_number], found["labels"][row_number], dataset_id, row_number


def _callback(value: object) -> str | None:
    """A callback: a day ("2026-10-20"), or a day and a time of this computer's clock ("2026-10-20T15:30")."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    try:
        if "T" in text:
            return datetime.fromisoformat(text).strftime("%Y-%m-%dT%H:%M")
        return date.fromisoformat(text).isoformat()
    except ValueError:
        raise ValueError("Give the callback as a day, or a day and a time") from None


def event(store: ProjectStore, key: str, kind: str, detail: dict, dataset_id: str | None, row_number: int | None, at: str | None = None) -> None:
    store._connection.execute(
        "INSERT INTO lead_events(id, lead_key, kind, detail_json, at, dataset_id, row_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid4()), key, kind, json.dumps(detail, sort_keys=True), at or utc_now(), dataset_id, row_number),
    )


def apply(store: ProjectStore, key: str, label: str, dataset_id: str, row_number: int, change: dict, why: str = "") -> dict:
    """Changes where a lead stands, keeping what is not changed, and writes each change into the lead's history.
    `why` says what made the change when it was not the person (a follow-up rule)."""
    current = store._connection.execute("SELECT * FROM lead_states WHERE lead_key = ?", (key,)).fetchone()
    state = _state(current) if current else {"stage": "new", "callback_on": None, "callback_note": ""}
    before = dict(state)
    if "stage" in change:
        if change["stage"] not in STAGES:
            raise ValueError("Choose one of the stages")
        state["stage"] = change["stage"]
    if "callback_on" in change:
        state["callback_on"] = _callback(change["callback_on"])
        if state["callback_on"] is None:
            state["callback_note"] = ""
    if "callback_note" in change and state["callback_on"]:
        state["callback_note"] = " ".join(str(change["callback_note"] or "").split())[:300]
    now = utc_now()
    with store._connection:
        store._connection.execute(
            "INSERT INTO lead_states(lead_key, stage, callback_on, callback_note, label, dataset_id, row_number, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(lead_key) DO UPDATE SET stage = excluded.stage, callback_on = excluded.callback_on, callback_note = excluded.callback_note, "
            "label = excluded.label, dataset_id = excluded.dataset_id, row_number = excluded.row_number, updated_at = excluded.updated_at",
            (key, state["stage"], state["callback_on"], state["callback_note"], label, dataset_id, row_number, now),
        )
        extra = {"why": why} if why else {}
        if state["stage"] != before["stage"]:
            event(store, key, "stage", {"from": before["stage"], "to": state["stage"], **extra}, dataset_id, row_number, now)
        if state["callback_on"] != before["callback_on"] or (state["callback_on"] and state["callback_note"] != before["callback_note"]):
            event(store, key, "callback", {"on": state["callback_on"], "note": state["callback_note"], **extra}, dataset_id, row_number, now)
    return {"lead_key": key, **state, "updated_at": now}


def set_state(store: ProjectStore, payload: dict) -> dict:
    """Sets a lead's stage, its callback (a day, or a day and a time) and what the callback is about. What is not
    given stays as it was; a callback of null takes the callback away."""
    key, label, dataset_id, row_number = _lead(store, payload)
    return apply(store, key, label, dataset_id, row_number, {name: payload[name] for name in ("stage", "callback_on", "callback_note") if name in payload})


def notes(store: ProjectStore, payload: dict) -> list[dict]:
    key = _lead(store, payload)[0]
    return [{"id": row["id"], "note": row["note"], "at": row["at"]} for row in store._connection.execute(
        "SELECT id, note, at FROM lead_notes WHERE lead_key = ? AND removed_at IS NULL ORDER BY at DESC, id", (key,))]


def add_note(store: ProjectStore, payload: dict) -> list[dict]:
    key, label, dataset_id, row_number = _lead(store, payload)
    text = str(payload.get("note") or "").strip()
    if not text:
        raise ValueError("Write the note first")
    if len(text) > MAX_NOTE:
        raise ValueError(f"A note holds up to {MAX_NOTE:,} characters")
    with store._connection:
        store._connection.execute("INSERT INTO lead_notes(id, lead_key, note, at, dataset_id, row_number) VALUES (?, ?, ?, ?, ?, ?)", (str(uuid4()), key, text, utc_now(), dataset_id, row_number))
        del label
    return notes(store, payload)


def remove_note(store: ProjectStore, payload: dict) -> list[dict]:
    with store._connection:
        store._connection.execute("UPDATE lead_notes SET removed_at = ? WHERE id = ? AND removed_at IS NULL", (utc_now(), str(payload.get("id"))))
    return notes(store, payload)


def due(store: ProjectStore, project_id: str, today: str | None = None) -> dict:
    """The callbacks that are due (today or before) and the ones to come, soonest first, with how many leads are at
    each stage. A callback whose list was deleted is left out."""
    today = today or date.today().isoformat()
    here = {row["id"]: row["name"] for row in store._connection.execute("SELECT id, name FROM datasets WHERE project_id = ?", (project_id,))}
    callbacks = []
    stages = dict.fromkeys(STAGES, 0)
    for row in store._connection.execute("SELECT * FROM lead_states ORDER BY callback_on, updated_at"):
        if row["dataset_id"] not in here:
            continue
        stages[row["stage"]] = stages.get(row["stage"], 0) + 1
        if row["callback_on"]:
            callbacks.append({"lead_key": row["lead_key"], "label": row["label"], "on": row["callback_on"], "note": row["callback_note"], "stage": row["stage"],
                              "dataset_id": row["dataset_id"], "list": here[row["dataset_id"]], "row_number": row["row_number"], "due": row["callback_on"][:10] <= today,
                              "time": row["callback_on"][11:16] or None})
    return {"today": today, "due": [item for item in callbacks if item["due"]], "coming": [item for item in callbacks if not item["due"]][:50], "stages": stages}


def zones(numbers: object) -> dict:
    """The time zones each phone number is in, by its area code, so the window can say what time it is there. A
    number in several zones (a toll-free line) or in none it knows gets an empty list: its hour is not known."""
    found = {}
    for number in list(numbers or [])[:5000]:
        try:
            named = phone_zones.time_zones_for_number(phonenumbers.parse(str(number)))
        except phonenumbers.NumberParseException:
            named = ()
        found[str(number)] = [zone for zone in named if "/" in zone]
    return found
