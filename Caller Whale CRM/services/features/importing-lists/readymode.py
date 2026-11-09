"""Interpret a ReadyMode call-log export without treating each call as a new lead."""
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo


def key(value: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", value.lower()).split())


REQUIRED = {"log time", "phone", "log type", "first name", "last name"}


def columns(headers: list[str]) -> dict[str, int]:
    found = {key(header): i for i, header in enumerate(headers)}
    missing = REQUIRED - found.keys()
    if missing:
        raise ValueError("This is not a ReadyMode call log. Missing: " + ", ".join(sorted(missing)) + ".")
    return found


def phone(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits if len(digits) == 10 else ""


def moment(value: str, zone: ZoneInfo):
    value = (value or "").strip()
    if not value or key(value) in {"not scheduled", "n a", "none", "0"}:
        return None
    try:
        parsed = datetime.strptime(value, "%m/%d/%Y %H:%M")
    except ValueError:
        return None
    return parsed.replace(tzinfo=zone).astimezone(timezone.utc).isoformat()


OUTCOMES = {
    "voicemail": ("Voicemail", "VM", "voicemail"),
    "not interested": ("Not interested", "NI", "reached"),
    "wrong number": ("Wrong number", "W#", "wrong_number"),
    "dead call": ("Dead call", "Dead", "no_answer"),
    "not available": ("Not available", "NA", "no_answer"),
    "transfer": ("Transfer", "Trans", "reached"),
    "do not call": ("Do not call", "DNC", "do_not_call"),
    "callback": ("Callback", "CB", "reached"),
    "spanish speaker": ("Language barrier", "Lang", "reached"),
    "language barrier": ("Language barrier", "Lang", "reached"),
}


def event(cells: list[str], positions: dict[str, int], zone: ZoneInfo) -> dict | None:
    get = lambda name: (cells[positions[name]].strip() if name in positions and positions[name] < len(cells) else "")
    occurred = moment(get("log time"), zone)
    numbers = list(dict.fromkeys(filter(None, [phone(get("phone")), *(phone(get(f"ph {i}")) for i in range(2, 11))])))
    if not occurred or not numbers:
        return None
    raw_outcome = get("log type")
    outcome, code, meaning = OUTCOMES.get(key(raw_outcome), (raw_outcome or "Unknown", get("abbreviation"), "unknown"))
    first, last = get("first name"), get("last name")
    return {
        "source_record_id": get("a"), "agent": get("agent name"), "occurred_at": occurred,
        "scheduled_at": moment(get("scheduled time"), zone), "phone": numbers[0], "phones": numbers,
        "name": " ".join(x for x in (first, last) if x), "address": get("address"), "city": get("city"),
        "region": get("state"), "zip": get("zip code"), "county": get("county"), "email": get("email").lower(),
        "company": get("company name"), "employee_count": get("employees") or get("# employees"),
        "consent_date": get("consent date"), "outcome": outcome, "raw_outcome": raw_outcome, "code": code,
        "meaning": meaning, "notes": get("call notes"), "sent_to": get("sent to"),
        "recording_started_at": moment(get("recording start"), zone),
        "recording_ended_at": moment(get("recording end"), zone),
    }
