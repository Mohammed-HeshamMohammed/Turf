"""Skip Tracing: how far a phone number can be trusted, and what a phone column is worth.

This is not duplicate checking (that is Clean & Combine). Each value gets one of four verdicts, with the reasons:

- ``wrong``       certain: not a real number for its country, a made-up number, a number a caller marked as a wrong
                  number, or one on a do-not-call list. (Do-not-call is a reason under wrong for now; the reason code
                  ``do_not_call`` keeps it separable.)
- ``suspicious``  probably bad, with the evidence that says so.
- ``unverified``  a valid number and nothing else is known. A valid number follows its country's numbering plan; it is
                  not proof that the number is connected or belongs to this person.
- ``corroborated`` valid, and someone reached a person at it, or independent files agree on it for the same person.

Evidence outranks guesses. The warning signs are measured against the call outcomes in the user's own files, so a sign
that does not predict a wrong number there (an area code from another state, for example) is reported as such.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from functools import lru_cache

import phonenumbers

from . import phone as phone_rules
from . import status_meaning
from .cleanup import _US_CODES as _US_STATE_CODES, state_or_region

SKIPTRACE_VERSION = 5  # 5: a disconnected line counts as a bad number when measuring the warning signs
VERDICTS = ("wrong", "suspicious", "unverified", "corroborated")
OUTCOMES = ("wrong_number", "do_not_call", "reached", "wrong_person", "disconnected", "voicemail", "no_answer")
OUTCOME_LABELS = {"wrong_number": "Wrong number", "do_not_call": "Do not call", "reached": "Reached a person", "wrong_person": "Wrong person (this person only)", "disconnected": "Disconnected", "voicemail": "Voicemail", "no_answer": "No answer"}
MAX_EXAMPLES = 3
MAX_STATUSES = 80

SIGNALS = {
    "shared_number": "The same number is listed for several different people",
    "business_line": "A toll-free, premium-rate or other non-personal number in a person's list",
    "area_code_other_state": "The area code is from a different state than the property",
    "country_mismatch": "The phone is from a different country than the address",
    "same_as_other_column": "The same number as another phone column in the row",
}
# Signs that make a number suspicious when switched on. The last is measured only: it describes the data, it does not judge.
COUNTABLE_SIGNALS = ("shared_number", "business_line", "area_code_other_state", "country_mismatch")
DEFAULT_SIGNALS = {"shared_number": True, "business_line": True, "area_code_other_state": False, "country_mismatch": True}

REASON_LABELS = {
    "known_wrong": "Marked as a wrong number in the files",
    "do_not_call": "On a do-not-call list in the files",
    "conflicting_outcomes": "Some calls say wrong number and others reached a person",
    "reached": "A call reached a person at this number",
    "agreed_by_files": "Independent files agree on this number for the same person",
    "dnc_expired": "A do-not-call mark that has expired (not blocking)",
    "shared_number": SIGNALS["shared_number"],
    "business_line": SIGNALS["business_line"],
    "area_code_other_state": SIGNALS["area_code_other_state"],
    "country_mismatch": SIGNALS["country_mismatch"],
    **{f"format_{code}": text.replace("{place}", "its country") for code, text in phone_rules.REASONS.items()},
}

_DATE_AFTER_UNTIL = re.compile(r"\b(until|till|through|thru|expires?|exp)\s*:?\s*(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4})", re.IGNORECASE)


def suggest_outcomes(key: str) -> list[str]:
    """What a status most likely means, by the phrase rules alone (turf_matching.status_meaning). A do-not-call alone does
    not say a person was reached: a scrubbing list is not a conversation."""
    return status_meaning.read_rules(key).outcomes


# ---------------------------------------------------------------------------------------------- outcome columns

def _parse_date(text: str, day_first: bool) -> date | None:
    parts = re.split(r"[/\-.]", text)
    if len(parts) != 3:
        return None
    try:
        a, b, c = (int(part) for part in parts)
        if a > 31:  # year first
            return date(a, b, c)
        year = c + 2000 if c < 100 else c
        return date(year, b, a) if day_first else date(year, a, b)
    except ValueError:
        return None


def normalize_status(value: object, day_first: bool = False) -> tuple[str, date | None]:
    """A status text without its date, so "DNC until 10/15/2025:Not interested" and the same with another date group
    together. Returns the grouping key and the date the text names, if any."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    until = None
    match = _DATE_AFTER_UNTIL.search(text)
    if match:
        until = _parse_date(match.group(2), day_first)
        text = _DATE_AFTER_UNTIL.sub(lambda found: f"{found.group(1).lower()} [date]", text)
    return text.casefold(), until


def status_table(values, day_first: bool = False, limit: int | None = None, memory: dict | None = None, embed=None) -> list[dict]:
    """Every distinct status (dates folded together) with how often it occurs, its suggested meaning, and whether that
    meaning is sure enough to confirm without the person (see turf_matching.status_meaning)."""
    counts: Counter = Counter()
    examples: dict[str, str] = {}
    for value in values:
        text = str(value or "").strip()
        if not text:
            continue
        key, _ = normalize_status(text, day_first)
        counts[key] += 1
        examples.setdefault(key, text)
    common = counts.most_common(limit)
    readings = status_meaning.read_statuses([key for key, _ in common], memory, embed)
    table = [{"key": key, "example": examples[key], "count": count, "outcomes": readings[key].outcomes, "sure": readings[key].sure,
              "source": readings[key].source, "why": readings[key].why, "doubt": readings[key].doubt} for key, count in common]
    rest = sum(counts.values()) - sum(item["count"] for item in table)
    if rest:
        table.append({"key": "", "example": f"{len(counts) - len(table)} other statuses", "count": rest, "outcomes": [], "sure": False, "source": "none", "why": "", "doubt": "unknown"})
    return table


# ---------------------------------------------------------------------------------------------- reading rows

@lru_cache(maxsize=400_000)
def _cell(value: str, region: str, country: str, source: str) -> tuple:
    return tuple(phone_rules.analyze_cell(value, region, country or None, source))


def read_cell(value: object, region: str, country: object = None, source: str = "the Country column") -> tuple:
    text = "" if value is None else str(value)
    return _cell(text, region, "" if country is None else str(country), source)


def _clean(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


_NAME_SUFFIXES = frozenset({"jr", "sr", "ii", "iii", "iv", "md", "phd", "esq"})


def _name_tokens(text: str) -> frozenset:
    """The meaningful words of a name: no initials, suffixes or punctuation. Works for any script and any naming order."""
    words = re.findall(r"\w+", text.casefold())
    return frozenset(word for word in words if len(word) > 1 and word not in _NAME_SUFFIXES)


OWNER_CONTEXT_COLUMNS = ("mailing_address_column", "mailing_city_column", "mailing_state_column", "mailing_zip_column", "owner_type_column")
OWNER_COLUMNS = ("first_name_column", "last_name_column", "name_column", *OWNER_CONTEXT_COLUMNS)


def owner_config(config: dict, phone_column: str) -> dict:
    """Resolve the owner of a phone field. Multiple owners require an explicit association."""
    owners = config.get("additional_owners") or []
    index = (config.get("phone_owner_map") or {}).get(phone_column, -1 if owners else 0)
    if index == 0:
        return config
    owner = owners[index - 1] if 1 <= index <= len(owners) else {}
    return {**config, **{key: owner.get(key) for key in OWNER_COLUMNS}}


def person_keys(row: dict, config: dict) -> tuple[str | None, frozenset | None]:
    """(a key for "the same person", the name words that identify the family). Two people are one family when their names
    share a word, so a couple who share a phone are not counted as strangers, whether the data has a last-name column,
    one full-name column, or compound surnames."""
    first = _clean(row.get(config.get("first_name_column") or "")).casefold()
    last = _clean(row.get(config.get("last_name_column") or "")).casefold()
    full = _clean(row.get(config.get("name_column") or "")).casefold()
    postal_column = config.get("mailing_zip_column") or config.get("zip_column")
    zip_code = re.sub(r"[^0-9a-z]", "", str(row.get(postal_column or "") or "").casefold())[:6]
    if last:
        who, words = f"{first.split(' ')[0] if first else ''} {last}".strip(), _name_tokens(last)
    elif full:
        who, words = full, _name_tokens(full)
    else:
        return None, None
    return (f"{who}|{zip_code}" if zip_code else who), (words or None)


def count_families(groups: list) -> int:
    """How many separate families a list of name-word sets holds: sets that share any word are joined."""
    parents = list(range(len(groups)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    owner: dict[str, int] = {}
    for index, words in enumerate(groups):
        for word in words:
            if word in owner:
                parents[find(index)] = find(owner[word])
            else:
                owner[word] = index
    return len({find(index) for index in range(len(groups))})


def _outcomes_of(row: dict, config: dict, day_first: bool) -> tuple[list[str], date | None]:
    outcome = config.get("outcome") or {}
    column = outcome.get("column")
    if not column:
        return [], None
    key, until = normalize_status(row.get(column), day_first)
    return list((outcome.get("map") or {}).get(key, [])) if key else [], until


def _called_column(config: dict) -> str | None:
    outcome = config.get("outcome") or {}
    columns = config.get("phone_columns") or []
    return outcome.get("called_column") or (columns[0] if columns else None)


_UK_POSTCODE = re.compile(r"^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$")
_CANADA_POSTCODE = re.compile(r"^[A-Z]\d[A-Z]\s?\d[A-Z]\d$")
_ZIP_PLUS_FOUR = re.compile(r"^\d{5}-\d{4}$")


def address_region(row: dict, config: dict) -> tuple[str | None, str]:
    """The country a row's address is in, and how that was found: the Country column, then the shape of the postal
    code (a UK postcode, a Canadian one, a ZIP+4), then a US state. A bare five-digit code says nothing: Germany,
    France, Spain, Mexico and Egypt use them too. Returns (None, "") when nothing says."""
    column = config.get("country_column")
    if column and _clean(row.get(column)):
        found = phone_rules.region_from_country(row.get(column))
        if found:
            return found, "the Country column"
    postal = _clean(row.get(config.get("zip_column") or "")).upper()
    if postal:
        if _UK_POSTCODE.match(postal):
            return "GB", "the postcode"
        if _CANADA_POSTCODE.match(postal):
            return "CA", "the postal code"
        if _ZIP_PLUS_FOUR.match(postal):
            return "US", "the ZIP code"
    state = _clean(row.get(config.get("state_column") or ""))
    if state:
        code = state_or_region(state, "US")[0]
        if len(code) == 2 and code.isupper() and code in _US_STATE_CODES:
            return "US", "the state"
    return None, ""


def _row_country(row: dict, config: dict) -> tuple[object, str]:
    """What to pass the phone reader as the row's country, and where it came from."""
    column = config.get("country_column")
    if column and _clean(row.get(column)):
        return row.get(column), "the Country column"
    region, source = address_region(row, config)
    return region, source or "the address"


# ---------------------------------------------------------------------------------------------- knowledge

@dataclass
class Knowledge:
    """What the files already say about each number, gathered from every dataset that has an outcome column."""

    wrong: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    reached: dict[str, list[str]] = field(default_factory=lambda: defaultdict(list))
    dnc: dict[str, list[tuple[str, date | None]]] = field(default_factory=lambda: defaultdict(list))
    people: dict[str, dict[str, set]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(set)))
    events: dict[str, list[dict]] = field(default_factory=lambda: defaultdict(list))
    lookups: dict[str, dict] = field(default_factory=dict)

    def merge_outcomes(self) -> int:
        return len(self.wrong) + len(self.dnc)


def collect(knowledge: Knowledge, rows: list[dict], config: dict, source_id: str, source_name: str, checkpoint=None) -> None:
    """Adds one dataset's call outcomes and who-has-which-number to the shared knowledge. `source_id` identifies the
    file's content, so two copies of the same file count once."""
    region = config.get("region") or "US"
    day_first = region != "US"
    called = _called_column(config)
    has_outcome = bool((config.get("outcome") or {}).get("column"))
    for index, row in enumerate(rows):
        if checkpoint and index % 250 == 0:
            checkpoint()
        country, source = _row_country(row, config)
        outcomes, until = _outcomes_of(row, config, day_first) if has_outcome else ([], None)
        for column in config.get("phone_columns") or []:
            who, _ = person_keys(row, owner_config(config, column))
            for info in read_cell(row.get(column), region, country, source):
                if not info.valid or not info.e164:
                    continue
                if who:
                    knowledge.people[info.e164][source_id].add(who)
                if column != called or not outcomes:
                    continue
                call_date = _clean(row.get(config.get("call_date_column") or ""))
                occurred_at = None
                if call_date:
                    try:
                        parsed = datetime.fromisoformat(call_date.replace("Z", "+00:00"))
                        if parsed.tzinfo is None:
                            parsed = parsed.replace(tzinfo=timezone.utc)
                        parsed = parsed.astimezone(timezone.utc)
                        if parsed <= datetime.now(timezone.utc):
                            occurred_at = parsed.isoformat()
                    except ValueError:
                        parsed_date = _parse_date(call_date, day_first)
                        if parsed_date and parsed_date <= date.today():
                            occurred_at = parsed_date.isoformat() + "T00:00:00+00:00"
                for outcome in outcomes:
                    knowledge.events[info.e164].append({"outcome": outcome, "occurred_at": occurred_at, "source": source_name, "person_key": who if outcome == "wrong_person" else None, "scope_unknown": outcome == "wrong_person" and not who})
                if "wrong_number" in outcomes or "disconnected" in outcomes:
                    knowledge.wrong[info.e164].append(source_name)
                if "do_not_call" in outcomes:
                    knowledge.dnc[info.e164].append((source_name, until))
                if "reached" in outcomes and "wrong_number" not in outcomes:
                    knowledge.reached[info.e164].append(source_name)


def _sources_text(names: list[str], own: str) -> str:
    distinct = list(dict.fromkeys(names))
    text = ", ".join(("this file" if name == own else name) for name in distinct[:3]) + (f" and {len(distinct) - 3} more" if len(distinct) > 3 else "")
    return f"{len(names)} time{'s' if len(names) != 1 else ''} ({text})"


# ---------------------------------------------------------------------------------------------- judging

@lru_cache(maxsize=100_000)
def _state_of_e164(e164: str) -> str | None:
    try:
        from phonenumbers import geocoder

        place = geocoder.description_for_number(phonenumbers.parse(e164), "en") or ""
    except Exception:  # noqa: BLE001
        return None
    found = re.search(r",\s*([A-Z]{2})$", place.strip())
    if found:
        return found.group(1)
    code = state_or_region(re.sub(r" state$", "", place, flags=re.IGNORECASE), "US")[0]
    return code if len(code) == 2 and code.isupper() else None


def _state_of_number(info) -> str | None:
    if info.region != "US" or not info.e164:
        return None
    return _state_of_e164(info.e164)


def _state_of_row(row: dict, config: dict) -> str | None:
    column = config.get("state_column")
    if not column or not _clean(row.get(column)):
        return None
    code = state_or_region(_clean(row.get(column)), "US")[0]
    return code if len(code) == 2 and code.isupper() else None


def _country_mismatch(info, row: dict, config: dict) -> bool:
    """A number whose country code is not the address country's. +1 covers the US, Canada and several territories, so
    those do not count as different from each other."""
    where, _ = address_region(row, config)
    if not where or not info.country_code:
        return False
    import phonenumbers

    return phonenumbers.country_code_for_region(where) != info.country_code


def judge(info, row: dict, config: dict, context: dict) -> tuple[str, list[dict]]:
    """One number's verdict and every reason behind it. A reason is {code, text, effect}; `effect` is the verdict it pushes toward."""
    if not info.valid or not info.e164:
        return "wrong", [{"code": f"format_{info.reason}", "text": info.detail or REASON_LABELS.get(f"format_{info.reason}", "Not a valid number"), "effect": "wrong"}]
    knowledge: Knowledge = context["knowledge"]
    today, own = context["today"], context["own_name"]
    e164 = info.e164
    reasons: list[dict] = []
    wrong, reached = knowledge.wrong.get(e164, []), knowledge.reached.get(e164, [])
    active = [(name, until) for name, until in knowledge.dnc.get(e164, []) if until is None or until >= today]
    expired = [(name, until) for name, until in knowledge.dnc.get(e164, []) if until is not None and until < today]

    if wrong and not reached:
        reasons.append({"code": "known_wrong", "text": f"Marked wrong number {_sources_text(wrong, own)}", "effect": "wrong"})
    elif wrong and reached:
        reasons.append({"code": "conflicting_outcomes", "text": f"Marked wrong number {len(wrong)}× but reached a person {len(reached)}×. Wrong: {_sources_text(wrong, own)}; reached: {_sources_text(reached, own)}", "effect": "suspicious"})
    if active:
        name, until = active[0]
        when = f"until {until.isoformat()}" if until else "with no end date"
        reasons.append({"code": "do_not_call", "text": f"Do not call: on a do-not-call list in {'this file' if name == own else name} {when}", "effect": "wrong"})
    if expired:
        reasons.append({"code": "dnc_expired", "text": f"A do-not-call mark ended on {max(until for _, until in expired).isoformat()}", "effect": "note"})

    counted = {**DEFAULT_SIGNALS, **(config.get("signals") or {})}
    if counted.get("shared_number") and context["family_count"].get(e164, 0) >= 2:
        reasons.append({"code": "shared_number", "text": f"Listed for {context['family_count'][e164]} different people", "effect": "suspicious"})
    if counted.get("business_line") and info.business_line:
        reasons.append({"code": "business_line", "text": f"A {info.type} number, not a person's own line", "effect": "suspicious"})
    if counted.get("area_code_other_state"):
        phone_state, row_state = _state_of_number(info), _state_of_row(row, config)
        if phone_state and row_state and phone_state != row_state:
            reasons.append({"code": "area_code_other_state", "text": f"Area code is from {phone_state}; the property is in {row_state}", "effect": "suspicious"})

    if counted.get("country_mismatch") and _country_mismatch(info, row, config):
        where, _ = address_region(row, config)
        reasons.append({"code": "country_mismatch", "text": f"The phone is from {phone_rules.region_name(info.region)} (+{info.country_code}); the address is in {phone_rules.region_name(where)}", "effect": "suspicious"})
    effects = {reason["effect"] for reason in reasons}
    if reached and not wrong and not active:
        reasons.append({"code": "reached", "text": f"A call reached a person here {_sources_text(reached, own)}", "effect": "corroborated"})
    elif not wrong and not active:
        sources = knowledge.people.get(e164, {})
        who = context["who"]
        if who and sum(1 for people in sources.values() if who in people) >= 2:
            reasons.append({"code": "agreed_by_files", "text": f"{sum(1 for people in sources.values() if who in people)} different files list this number for the same person", "effect": "corroborated"})
    effects = {reason["effect"] for reason in reasons}
    for verdict in ("wrong", "suspicious", "corroborated"):
        if verdict in effects:
            if verdict == "suspicious" and "corroborated" in effects:
                continue  # a person was reached here: that outweighs a guess
            return verdict, reasons
    return "unverified", reasons


_RANK = {"corroborated": 0, "unverified": 1, "suspicious": 2, "wrong": 3}
_EFFECT_ORDER = {"wrong": 0, "suspicious": 1, "note": 2, "corroborated": 3}


def evaluate(rows: list[dict], row_numbers: list[int], config: dict, knowledge: Knowledge, own_name: str, today: date | None = None, keep_rows: bool = False, checkpoint=None, progress=None) -> dict:
    """Judges every phone value in the rows. Returns the report, and with `keep_rows` the per-row results for saving."""
    today = today or date.today()
    region = config.get("region") or "US"
    day_first = region != "US"
    columns = list(config.get("phone_columns") or [])
    called = _called_column(config)
    has_outcome = bool((config.get("outcome") or {}).get("column"))

    # Who is listed at each number, by family, for the shared-number sign.
    families: dict[str, set] = defaultdict(set)   # number -> the name-word sets listed for it
    for index, row in enumerate(rows):
        if checkpoint and index % 250 == 0:
            checkpoint()
        country, source = _row_country(row, config)
        for column in columns:
            _, family = person_keys(row, owner_config(config, column))
            if not family:
                continue
            for info in read_cell(row.get(column), region, country, source):
                if info.valid and info.e164:
                    families[info.e164].add(family)
    family_count = {number: count_families(list(found)) for number, found in families.items()}
    from . import assessment
    import sys
    engine_module = sys.modules[__name__]
    sharing = assessment.shared_context(rows, config, engine_module)

    verdicts: Counter = Counter()
    column_stats = {column: {"filled": 0, "valid": 0, "wrong": 0, "adds_info": 0, "distinct": set(), "verdicts": Counter()} for column in columns}
    reason_counts: Counter = Counter()
    reason_effect: dict[str, str] = {}
    reason_examples: dict[str, list] = defaultdict(list)
    types: Counter = Counter()
    countries: Counter = Counter()
    notes: Counter = Counter()
    row_results: list[dict] = []
    outcome_rows: Counter = Counter()
    carried = Counter()
    callable_rows = 0
    sign_stats = {code: Counter() for code in SIGNALS}
    contacted_total = Counter()
    rows_with_phone = 0
    assessment_counts = Counter()

    for index, row in enumerate(rows):
        if index % 250 == 0:
            if checkpoint:
                checkpoint()
            if progress:
                progress(index, len(rows))
        country, source = _row_country(row, config)
        who, family = person_keys(row, config)
        context = {"knowledge": knowledge, "today": today, "own_name": own_name, "family_count": family_count, "who": who}
        outcomes, _ = _outcomes_of(row, config, day_first) if has_outcome else ([], None)
        if has_outcome:
            outcome_rows["tried" if outcomes else "not tried"] += 1
            for kind in outcomes:
                outcome_rows[kind] += 1
        per_column: dict[str, dict] = {}
        candidates = []
        seen_before: set[str] = set()
        any_phone = False
        for column in columns:
            context["who"], _ = person_keys(row, owner_config(config, column))
            infos = read_cell(row.get(column), region, country, source)
            if not infos:
                per_column[column] = {"verdict": "", "reasons": [], "e164": [], "type": []}
                continue
            any_phone = True
            stats = column_stats[column]
            judged = []
            for info in infos:
                verdict, reasons = judge(info, row, config, context)
                judged.append((info, verdict, reasons))
                candidates.append(assessment.assess(info, column, row, config, context, sharing, engine_module))
                stats["filled"] += 1
                stats["verdicts"][verdict] += 1
                verdicts[verdict] += 1
                if info.valid:
                    stats["valid"] += 1
                    stats["distinct"].add(info.e164)
                    types[info.type or "unknown"] += 1
                    countries[info.region or "?"] += 1
                if verdict == "wrong":
                    stats["wrong"] += 1
                if info.valid and info.e164 not in seen_before and verdict != "wrong":
                    stats["adds_info"] += 1
                if info.valid and info.e164:
                    seen_before.add(info.e164)
                for note in info.notes:
                    notes[note] += 1
                for reason in reasons:
                    reason_counts[reason["code"]] += 1
                    reason_effect[reason["code"]] = reason["effect"]
                    if len(reason_examples[reason["code"]]) < MAX_EXAMPLES:
                        reason_examples[reason["code"]].append({"row": row_numbers[index], "column": column, "value": _clean(info.raw)[:60], "text": reason["text"]})
            best = min(judged, key=lambda item: _RANK[item[1]])
            per_column[column] = {
                "verdict": best[1], "reasons": [r["text"] for _, _, rs in judged for r in rs],
                "e164": [info.e164 for info, _, _ in judged if info.e164], "type": [info.type for info, _, _ in judged if info.type],
                "judged": judged,
            }
        if any_phone:
            rows_with_phone += 1
        usable = [(column, data) for column, data in per_column.items() if data["verdict"] and data["verdict"] != "wrong"]
        best_column = min(usable, key=lambda item: (_RANK[item[1]["verdict"]], columns.index(item[0])), default=None)
        choices = assessment.rank(candidates)
        for choice in choices:
            assessment_counts[choice["quality"]] += 1
            assessment_counts["blocked_dnc"] += choice["permission"] == "blocked_dnc"
            assessment_counts["needs_review"] += bool(choice["warnings"]) or choice["quality"] == "suspicious"
            assessment_counts["shared_" + choice["shared"]["kind"]] += 1
        if any(not choice["blocked"] for choice in choices):
            callable_rows += 1
        known_bad = any(
            reason["code"] in ("known_wrong", "do_not_call")
            for data in per_column.values() for _, verdict, reasons in data.get("judged", []) for reason in reasons if verdict == "wrong"
        )
        if has_outcome and not outcomes and known_bad:
            carried["rows"] += 1
            for data in per_column.values():
                for _, verdict, reasons in data.get("judged", []):
                    for reason in reasons:
                        if reason["code"] in ("known_wrong", "do_not_call") and verdict == "wrong":
                            carried[reason["code"]] += 1
                            break

        # Measure each warning sign against the call outcome of this row's called number.
        if has_outcome and called and ("wrong_number" in outcomes or "disconnected" in outcomes or "reached" in outcomes):
            infos = read_cell(row.get(called), region, country, source)
            first = infos[0] if infos else None
            if first is not None and first.valid and first.e164:
                contacted_total["n"] += 1
                bad = "wrong_number" in outcomes or "disconnected" in outcomes
                contacted_total["wrong"] += bad
                present = {
                    "shared_number": family_count.get(first.e164, 0) >= 2,
                    "business_line": first.business_line,
                    "area_code_other_state": bool((a := _state_of_number(first)) and (b := _state_of_row(row, config)) and a != b),
                    "country_mismatch": _country_mismatch(first, row, config),
                    "same_as_other_column": any(first.e164 in {i.e164 for i in read_cell(row.get(other), region, country, source)} for other in columns if other != called),
                }
                for code, found in present.items():
                    if found:
                        sign_stats[code]["n"] += 1
                        sign_stats[code]["wrong"] += bad

        if keep_rows:
            row_results.append({"columns": per_column, "best": best_column, "outcomes": outcomes, "choices": choices})

    total_rows = len(rows)
    if checkpoint:
        checkpoint()
    if progress:
        progress(total_rows, total_rows)
    column_report = []
    share = lambda part, whole: round(part / whole, 4) if whole else 0  # noqa: E731
    for position, column in enumerate(columns):
        stats = column_stats[column]
        filled = stats["filled"]
        if filled / max(total_rows, 1) < 0.1:
            verdict_text = "Mostly empty"
        elif position and share(stats["adds_info"], filled) < 0.6:
            verdict_text = f"Often repeats an earlier column: it adds a new number in {share(stats['adds_info'], filled):.0%} of its values"
        elif share(stats["wrong"], filled) > 0.25:
            verdict_text = f"{share(stats['wrong'], filled):.0%} of its values are wrong"
        else:
            verdict_text = "Useful"
        column_report.append({
            "column": column, "filled": filled, "filled_share": share(filled, total_rows), "valid": stats["valid"], "valid_share": share(stats["valid"], filled),
            "distinct": len(stats["distinct"]), "wrong": stats["wrong"], "adds_info": stats["adds_info"], "adds_info_share": share(stats["adds_info"], filled),
            "verdicts": {name: stats["verdicts"].get(name, 0) for name in VERDICTS}, "verdict_text": verdict_text,
        })

    baseline = contacted_total["wrong"] / contacted_total["n"] if contacted_total["n"] else None
    signs = []
    if has_outcome:
        for code in SIGNALS:
            stats = sign_stats[code]
            rate = stats["wrong"] / stats["n"] if stats["n"] else None
            # A sign predicts when its wrong-number rate is clearly above the baseline: about two standard errors, which
            # a small group needs a big difference to reach. Without this a handful of rows looks like a pattern.
            z = ((rate - baseline) / ((baseline * (1 - baseline) / stats["n"]) ** 0.5)) if rate is not None and baseline and 0 < baseline < 1 and stats["n"] else None
            signs.append({
                "code": code, "label": SIGNALS[code], "contacted": stats["n"], "wrong": stats["wrong"], "wrong_rate": round(rate, 4) if rate is not None else None,
                "lift": round(rate / baseline, 2) if rate is not None and baseline else None,
                "counted": bool({**DEFAULT_SIGNALS, **(config.get("signals") or {})}.get(code)) if code in COUNTABLE_SIGNALS else False,
                "measured_only": code not in COUNTABLE_SIGNALS,
                "z": round(z, 2) if z is not None else None,
                "predictive": bool(z is not None and z >= 2 and rate / baseline >= 1.1),
                "enough_data": stats["n"] >= 50,
            })

    report = {
        "skiptrace_version": SKIPTRACE_VERSION, "phone_version": phone_rules.PHONE_VERSION, "metadata_version": phone_rules.METADATA_VERSION,
        "rows": total_rows, "rows_with_phone": rows_with_phone, "rows_with_callable_number": callable_rows,
        "values": sum(verdicts.values()), "verdicts": {name: verdicts.get(name, 0) for name in VERDICTS},
        # The reasons that make a number wrong come first, then suspicious ones, then notes and good news; each by how often.
        "reasons": [
            {"code": code, "label": REASON_LABELS.get(code, code), "count": count, "effect": reason_effect[code], "examples": reason_examples[code]}
            for code, count in sorted(reason_counts.items(), key=lambda item: (_EFFECT_ORDER[reason_effect[item[0]]], -item[1]))
        ],
        "columns": column_report, "types": dict(types.most_common()), "countries": dict(countries.most_common(12)),
        "repairs": [{"note": note, "count": count} for note, count in notes.most_common(8)],
        "outcomes": {
            "available": has_outcome, "rows": dict(outcome_rows), "baseline_wrong_rate": round(baseline, 4) if baseline is not None else None,
            "contacted": contacted_total["n"], "known_wrong_numbers": len(knowledge.wrong),
            "do_not_call_numbers": sum(1 for entries in knowledge.dnc.values() if any(u is None or u >= today for _, u in entries)),
            "expired_do_not_call_numbers": sum(1 for entries in knowledge.dnc.values() if entries and not any(u is None or u >= today for _, u in entries)),
            "carried_rows": carried["rows"], "carried_wrong_number": carried["known_wrong"], "carried_do_not_call": carried["do_not_call"],
        },
        "signals": signs,
        "phone_assessments": dict(assessment_counts),
    }
    if keep_rows:
        report["_row_results"] = row_results
    return report


# ---------------------------------------------------------------------------------------------- suggesting a setup

_PHONE_HEADER = re.compile(r"phone|mobile|cell|tel(?!l)|fax|whatsapp|contact number|landline|gsm|celular|m[oó]vil|portable|handy|هاتف|موبايل|جوال|تليفون|محمول", re.IGNORECASE)
_IDENTIFIER_HEADER = re.compile(r"\b(?:id|identifier|apn|parcel|account|property|mls|tax|zip|postal|ssn)\b", re.IGNORECASE)
_OUTCOME_HEADER = re.compile(r"status|outcome|disposition|dispo\b|result|call (result|outcome)|dnc|stage|response", re.IGNORECASE)


def suggest(rows: list[dict], roles: dict[str, str], region: str = "US", sample: int = 400) -> dict:
    """A starting setup from the columns and a sample of rows. The person confirms or changes every part of it."""
    columns = list(dict.fromkeys(column for row in rows[:sample] for column in row))
    sampled = rows[:sample]
    phone_columns = [column for column, role in roles.items() if role == "phone" and column in columns]
    if not phone_columns:
        for column in columns:
            # A parcel/account ID can accidentally parse as a valid telephone number.
            # Only an explicit phone-like heading or a confirmed phone role should override that warning.
            if _IDENTIFIER_HEADER.search(column) and not _PHONE_HEADER.search(column):
                continue
            values = [_clean(row.get(column)) for row in sampled if _clean(row.get(column))]
            if not values:
                continue
            readable = sum(1 for value in values if any(info.valid for info in read_cell(value, region)))
            if _PHONE_HEADER.search(column) or readable / len(values) >= 0.6:
                phone_columns.append(column)

    def role_column(*wanted: str) -> str | None:
        return next((column for column, role in roles.items() if role in wanted and column in columns), None)

    outcome_candidates = []
    for column in columns:
        if column in phone_columns:
            continue
        values = [_clean(row.get(column)) for row in rows if _clean(row.get(column))]
        distinct = len(set(values))
        if _OUTCOME_HEADER.search(column) and values and 2 <= distinct <= 2000:
            # How much of it reads like call results: a listing's "Status" ("House for sale") is named the same way.
            keys = Counter(normalize_status(value)[0] for value in values)
            understood = sum(count for key, count in keys.items() if status_meaning.read_rules(key).doubt != "unknown") / len(values)
            outcome_candidates.append({"column": column, "filled": len(values), "distinct": distinct, "understood": round(understood, 3)})
    outcome_candidates.sort(key=lambda item: -item["understood"])
    config = {
        "phone_columns": phone_columns, "region": region, "country_column": role_column("country"),
        "first_name_column": role_column("first_name"), "last_name_column": role_column("last_name"), "name_column": role_column("name"),
        "zip_column": role_column("postal_code"), "state_column": role_column("region"),
        "outcome": None, "signals": dict(DEFAULT_SIGNALS),
    }
    # Numbered owners and mailing fields are distinct from the property's location.
    owners = {}
    bindings = {}
    aliases = {"firstname": "first_name_column", "lastname": "last_name_column", "fullname": "name_column", "name": "name_column",
               "mailingaddress": "mailing_address_column", "mailingstreetaddress": "mailing_address_column", "mailingcity": "mailing_city_column", "mailingstate": "mailing_state_column",
               "mailingzip": "mailing_zip_column", "mailingzipcode": "mailing_zip_column", "mailingpostalcode": "mailing_zip_column", "type": "owner_type_column", "ownertype": "owner_type_column"}
    for column in columns:
        header = re.sub(r"[^a-z0-9]", "", column.casefold())
        numbered = re.search(r"owner(\d+)", header) or (re.search(r"(\d+)$", header) if "owner" in header else None)
        index = int(numbered.group(1)) - 1 if numbered else 0
        if not 0 <= index < 20:
            continue
        stripped = re.sub(r"owner\d*", "", header).rstrip("0123456789")
        key = aliases.get(stripped) or ("name_column" if not stripped and "owner" in header else None)
        if key and ("owner" in header or header.startswith("mailing")):
            owners.setdefault(index, {})[key] = column
        if column in phone_columns and "owner" in header:
            bindings[column] = index
        if header in ("vacant", "vacancy", "isvacant", "vacantproperty"):
            config["vacancy_column"] = column
        if header in ("address", "propertyaddress", "streetaddress"):
            config["address_column"] = column
        if header in ("city", "propertycity"):
            config["city_column"] = column
        if header in ("state", "propertystate"):
            config["state_column"] = column
        if header in ("zip", "zipcode", "propertyzip", "propertyzipcode", "postalcode", "propertypostalcode"):
            config["zip_column"] = column
    maximum = max([*owners.keys(), *bindings.values()], default=0)
    config.update(owners.get(0, {}))
    config["additional_owners"] = [owners.get(index, {}) for index in range(1, maximum + 1)]
    config["phone_owner_map"] = bindings
    secondary_columns = {column for owner in config["additional_owners"] for column in owner.values()}
    for key in OWNER_COLUMNS:
        if config.get(key) in secondary_columns:
            config[key] = None
    for key in ("zip_column", "state_column"):
        if config.get(key) and "mailing" in re.sub(r"[^a-z]", "", config[key].casefold()):
            config[key] = None
    return {"config": config, "outcome_candidates": outcome_candidates, "columns": columns}
