"""Project-local manual evidence. Removing a mark never removes its audit history."""
from __future__ import annotations

import re
from datetime import date

from .storage import ProjectStore, utc_now

MARKS = {"called", "wrong_number", "do_not_call", "interested"}


def list_marks(store: ProjectStore) -> dict:
    return {row["number"]: {"mark": row["mark"], "at": row["at"], "until": row["until_date"], "source": row["source"]}
            for row in store._connection.execute("SELECT * FROM manual_marks ORDER BY number")}


def set_mark(store: ProjectStore, number: str, mark: str | None, until: str | None = None, *, at: str | None = None, source: str = "Turf") -> dict:
    if not re.fullmatch(r"\+[0-9]{6,15}", number):
        raise ValueError("A mark needs one phone number in international format")
    if mark is not None and mark not in MARKS:
        raise ValueError("Unknown manual mark")
    if until:
        if mark != "do_not_call":
            raise ValueError("Only a do-not-call mark has an end date")
        until = date.fromisoformat(until).isoformat()
    at = at or utc_now()
    with store._connection:
        store._connection.execute("INSERT INTO manual_mark_history(number, mark, at, until_date, source) VALUES (?, ?, ?, ?, ?)", (number, mark, at, until, source))
        if mark is None:
            store._connection.execute("DELETE FROM manual_marks WHERE number = ?", (number,))
        else:
            store._connection.execute("INSERT INTO manual_marks(number, mark, at, until_date, source) VALUES (?, ?, ?, ?, ?) ON CONFLICT(number) DO UPDATE SET mark=excluded.mark, at=excluded.at, until_date=excluded.until_date, source=excluded.source", (number, mark, at, until, source))
    return list_marks(store)


def history(store: ProjectStore, number: str | None = None) -> list[dict]:
    return [dict(row) for row in store._connection.execute(
        "SELECT number, mark, at, until_date AS until, source FROM manual_mark_history WHERE (? IS NULL OR number = ?) ORDER BY id DESC", (number, number))]


def import_legacy(store: ProjectStore, marks: dict) -> dict:
    """Explicit import, preserving existing project marks and the old computer store."""
    current = list_marks(store)
    previously_recorded = {row[0] for row in store._connection.execute("SELECT DISTINCT number FROM manual_mark_history")}
    for number, entry in marks.items():
        if number not in current and number not in previously_recorded:
            set_mark(store, number, entry["mark"], entry.get("until"), at=entry.get("at"), source="Imported computer mark")
    return list_marks(store)
