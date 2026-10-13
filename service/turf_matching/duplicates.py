"""Rows of one list that repeat the same lead, found during a phone check.

Turf's own, built on DataForge's matching engine (engine.py, normalize.py and likelihood.py, copied unchanged): its
candidate groups, field evidence, guarded grouping and likelihood. What Turf adds, because a list of leads is not a
contact file:

- No second setup. The columns come from the Skip Tracing setup, and the phones from the check itself.
- One owner with several properties is not a duplicate. Those rows are told apart and reported as the same owner.
- Names as county rolls and dialers write them: "SMITH JOHN A" and "John Smith" are one name, a company is compared
  without its legal form, and a household ("SMITH JOHN & MARY") is not read as one person.
- An office or placeholder number on many rows under different names is not evidence that two rows are the same lead.
- Two rows for one lead often carry different phones, which is what skip tracing returns; a phone the rows do not
  share says nothing either way, and the same town or ZIP is not a second field to be sure on.
- The row to keep is the one with the best number to call, then the most complete, then the first.

Nothing is removed. Each row is given what it is (keep, duplicate of a row, possibly a duplicate) and why, in columns
the checked copy carries; the person decides what to do with them.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Callable

from . import engine, likelihood
from .cleanup import company_key
from .normalize import normalize_row, phone_keys, text

DUPLICATES_VERSION = 1
COLUMNS = ("Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows")
STRICTNESS = "conservative"
MAX_BLOCK_SIZE = 200
MAX_PAIRS = 2_000_000
# A phone or email on more rows than this, under more than two different names, is an office line or a placeholder.
MAX_SHARED = 5
# A pair the rules left for review is shown only when the list itself makes it at least this likely.
MIN_POSSIBLE = 0.3
MAX_EXAMPLES = 12

_EMAIL_HEADER = re.compile(r"e-?mail", re.IGNORECASE)
_COMPANY = re.compile(
    r"\b(llc|l\.?l\.?c|inc|incorporated|corp|corporation|company|ltd|limited|lp|llp|pllc|plc|partners|partnership|holdings?|properties|"
    r"investments?|investors|capital|group|enterprises?|ventures?|realty|development|management|associates|association|church|ministries|"
    r"foundation|hoa|trusts?|trustees?|estate of|heirs of|bank|credit union|city of|county of|state of)\b",
    re.IGNORECASE,
)
_SEVERAL = re.compile(r"&|\band\b|;|\bet ?(ux|vir|al)\b", re.IGNORECASE)
_JOINERS = frozenset({"and", "et", "ux", "vir", "al", "etux", "etvir", "etal"})
_NOT_A_NAME = frozenset({"jr", "sr", "ii", "iii", "iv", "mr", "mrs", "ms", "dr", "the", "of"})
_VERDICT_RANK = {"corroborated": 0, "unverified": 1, "suspicious": 2, "wrong": 3}
_FIELD_LABELS = {"phone": "phone", "email": "email", "address": "property address", "mailing_address": "mailing address", "name": "name", "identifier": "identifier"}


def roles(config: dict, columns: list[str]) -> dict[str, str]:
    """What each column is, for the engine, from the Skip Tracing setup. Email columns are known by their name."""
    mapping: dict[str, str] = {}

    def put(key: str, role: str) -> None:
        column = config.get(key)
        if column and column in columns and column not in mapping:
            mapping[column] = role

    for key, role in (
        ("first_name_column", "first_name"), ("last_name_column", "last_name"), ("name_column", "name"), ("address_column", "address"),
        ("city_column", "city"), ("state_column", "region"), ("zip_column", "postal_code"), ("mailing_address_column", "mailing_address"),
    ):
        put(key, role)
    phones = set(config.get("phone_columns") or [])
    for column in columns:
        if column not in mapping and column not in phones and _EMAIL_HEADER.search(column):
            mapping[column] = "email"
    return mapping


def _words(name: str) -> frozenset[str]:
    """The words of a name that tell people apart: no initials, titles or suffixes."""
    return frozenset(word for word in name.split() if len(word) >= 2 and word not in _NOT_A_NAME and word not in _JOINERS)


def _normalize(row: dict, mapping: dict[str, str], region: str, phones: set[str] | None) -> dict:
    n = normalize_row(row, mapping, region)
    if phones is not None:
        n["phone"] = set(phones)
    raw_name = " ".join(str(row.get(column) or "") for column, role in mapping.items() if role in ("name", "first_name", "last_name")).strip()
    if n.get("name"):
        if _COMPANY.search(raw_name):
            # A company is its name without the legal form, not a given name and a surname.
            n.pop("person", None)
            n["name"] = text(company_key(raw_name)) or n["name"]
        elif _SEVERAL.search(raw_name):
            # Two people on one line are a household: compared by its words, never as one person.
            n.pop("person", None)
            n["name"] = " ".join(word for word in str(n["name"]).split() if word not in _JOINERS)
        n["words"] = _words(str(n["name"]))
    return n


def _ignore_shared(normalized: dict[str, dict]) -> int:
    """Takes a phone or email carried by many rows under different names out of the evidence. Returns how many."""
    ignored = 0
    for field in ("phone", "email"):
        names: dict[str, set] = defaultdict(set)
        rows: Counter = Counter()
        for n in normalized.values():
            for value in n[field]:
                rows[value] += 1
                names[value].add(n.get("words") or frozenset())
        shared = {value for value, count in rows.items() if count > MAX_SHARED and len(names[value]) > 2}
        if shared:
            ignored += len(shared)
            for n in normalized.values():
                n[field] = n[field] - shared
    return ignored


def _block_size(normalized: dict[str, dict]) -> int:
    """The largest candidate group to compare inside, so the whole search stays within MAX_PAIRS comparisons.

    Rows are only compared inside a group that shares something (a phone, a street number and street, a name in
    one ZIP). A very long list can have groups so large that comparing inside all of them would take minutes; the
    largest are then left out, and the report says how many.
    """
    sizes: Counter = Counter()
    for n in normalized.values():
        sizes.update(set(engine._block_keys(n, True)))
    counts = [size for size in sizes.values() if size >= 2]
    for limit in (MAX_BLOCK_SIZE, 100, 50, 25, 10):
        if sum(size * (size - 1) // 2 for size in counts if size <= limit) <= MAX_PAIRS:
            return limit
    return 5


def compare(left: dict, right: dict) -> tuple[list[dict], float, int]:
    """The engine's field evidence, with names read the way lists of leads write them: the same words in another
    order, or with a middle initial, are the same name."""
    evidence, score, comparable = engine.compare(left, right, person=True)
    a, b = left.get("words"), right.get("words")
    if a and b and len(a) >= 2 and len(b) >= 2:
        item = next((item for item in evidence if item["field"] == "name"), None)
        if item is not None and item["similarity"] < 0.9:
            same, within = a == b, a <= b or b <= a
            # A guard (different first names) gives way only to exactly the same words; one name inside a longer
            # one ("John Smith" in "John & Mary Smith") is enough when nothing contradicts.
            if same or (within and item["strength"] != "guard"):
                item.update(similarity=1.0 if same else 0.95, result="exact" if same else "similar", strength="supporting",
                            explanation="Name: the same words in another order" if same else "Name: one name is part of the other")
    # Two rows for one lead often carry different numbers: that is what skip tracing returns. A phone or email the
    # rows do not share therefore says nothing either way, where in a contact file it counts against the pair.
    counted = [item for item in evidence if not (item["field"] in ("phone", "email") and item["result"] == "different")]
    total = sum(engine.WEIGHTS[item["field"]] for item in counted)
    score = sum(engine.WEIGHTS[item["field"]] * item["similarity"] for item in counted) / total if total else 0.0
    # The same city, state or ZIP is no second field to be sure on: a phone alone, in one town, stays for the person.
    comparable = len({item["field"] for item in counted} - {"region"})
    return evidence, score, comparable


def _same_owner(evidence: list[dict]) -> bool:
    """The same owner at another property: only the property keeps the rows apart, and a contact and the name agree."""
    guards = [item for item in evidence if item["strength"] == "guard"]
    if not guards or any(item["field"] != "address" for item in guards):
        return False
    by_field = {item["field"]: item for item in evidence}
    name = by_field.get("name")
    contact = any(by_field.get(field, {}).get("result") == "exact" for field in ("phone", "email")) or by_field.get("mailing_address", {}).get("strength") == "strong"
    return bool(contact and name and name["similarity"] >= 0.85)


def _why(evidence: list[dict]) -> str:
    agreeing = [_FIELD_LABELS[item["field"]] for item in evidence if item["field"] in _FIELD_LABELS and item["result"] in ("exact", "similar")]
    return ("Same " + ", ".join(agreeing[:-1]) + (" and " if len(agreeing) > 1 else "") + agreeing[-1]) if agreeing else "Similar values"


def _row_list(numbers: list[int]) -> str:
    shown = ", ".join(str(number) for number in numbers[:8])
    return f"row {shown}" if len(numbers) == 1 else f"rows {shown}" + (f" and {len(numbers) - 8} more" if len(numbers) > 8 else "")


def _label(row: dict, mapping: dict[str, str], phones: set[str]) -> str:
    def cell(*wanted: str) -> str:
        return " ".join(str(row.get(column) or "").strip() for column, role in mapping.items() if role in wanted).strip()

    parts = [cell("name", "first_name", "last_name"), cell("address"), next(iter(sorted(phones)), "")]
    return " · ".join(part for part in parts if part)[:160]


def find(
    rows: list[dict], row_numbers: list[int], config: dict, checked: list[dict] | None = None,
    checkpoint: Callable[[], None] | None = None, progress: Callable[[str, dict], None] | None = None,
) -> tuple[list[dict], dict]:
    """Returns (one dict of the four duplicate columns for each row, a summary for the report).

    `checked` is each row as the phone check wrote it (its numbers in international form, its best phone and that
    phone's verdict); without it the phones are read from the setup's phone columns.
    """
    checkpoint = checkpoint or (lambda: None)
    progress = progress or (lambda stage, detail: None)
    columns = list(dict.fromkeys(column for row in rows[:400] for column in row))
    mapping = roles(config, columns)
    region = str(config.get("region") or "US")
    phone_columns = [column for column in config.get("phone_columns") or [] if column in columns]
    if checked is None:
        mapping = {**mapping, **{column: "phone" for column in phone_columns}}

    def checked_phones(index: int) -> set[str] | None:
        if checked is None:
            return None
        numbers: set[str] = set()
        for column in phone_columns:
            read = {number.strip() for number in str(checked[index].get(f"{column} (E.164)") or "").split(";") if number.strip()}
            # A number the check could not read as valid is still the same number when two rows carry it.
            numbers |= read or phone_keys(rows[index].get(column), region)
        return numbers

    progress("finding_duplicates", {})
    ids = [str(index) for index in range(len(rows))]
    normalized: dict[str, dict] = {}
    for index, row in enumerate(rows):
        if index % 2000 == 0:
            checkpoint()
        normalized[ids[index]] = _normalize(row, mapping, region, checked_phones(index))
    ignored = _ignore_shared(normalized)

    block_size = _block_size(normalized)
    pairs, block_metrics = engine.generate_candidates(normalized, block_size, person=True)
    # Only pairs that are, or might be, the same lead are kept; the rest are the great majority and say nothing more.
    decisions: list[dict] = []
    owner_pairs: list[tuple[str, str]] = []
    for count, (left, right) in enumerate(sorted(pairs)):
        if count % 5000 == 0:
            checkpoint()
            progress("finding_duplicates", {"completed": count, "total": len(pairs)})
        evidence, score, comparable = compare(normalized[left], normalized[right])
        decision, reason = engine.decide(evidence, score, comparable, STRICTNESS)
        if decision == "non_match":
            if _same_owner(evidence):
                owner_pairs.append((left, right))
            continue
        decisions.append({"id": f"{left}|{right}", "left_row_id": left, "right_row_id": right, "evidence": evidence, "score": round(score, 4), "decision": decision, "reason": reason})
    compared = len(pairs)
    del pairs

    clusters, bridges, _ = engine.cluster(ids, normalized, decisions, [], [], person=True)
    bridged = set(bridges)
    for decision in decisions:
        if decision["id"] in bridged:
            decision["decision"] = "possible_match"
    checkpoint()
    likelihood.annotate(decisions, normalized, lambda left, right: compare(left, right)[0])
    by_pair = {(decision["left_row_id"], decision["right_row_id"]): decision for decision in decisions}

    def between(a: str, b: str) -> dict | None:
        return by_pair.get((a, b)) or by_pair.get((b, a))

    def filled(index: int) -> int:
        return sum(1 for value in rows[index].values() if value not in (None, ""))

    def rank(row_id: str) -> tuple:
        index = int(row_id)
        best = checked[index] if checked is not None else {}
        callable_ = bool(best.get("Best phone"))
        return (not callable_, _VERDICT_RANK.get(str(best.get("Best phone verdict") or ""), 4), -filled(index), row_numbers[index])

    out = [dict.fromkeys(COLUMNS, "") for _ in rows]
    cluster_of: dict[str, int] = {}
    examples: list[dict] = []
    groups = extra = 0
    for found in clusters:
        members = found["member_row_ids"]
        if len(members) < 2:
            continue
        groups += 1
        extra += len(members) - 1
        keep = min(members, key=rank)
        name = f"D{groups}"
        others = [member for member in members if member != keep]
        keep_phones = normalized[keep]["phone"]
        more = [row_numbers[int(member)] for member in others if normalized[member]["phone"] - keep_phones]
        callable_keep = checked is not None and bool(checked[int(keep)].get("Best phone"))
        for member in members:
            cluster_of[member] = groups
            index = int(member)
            out[index]["Duplicate group"] = name
            if member == keep:
                out[index]["Duplicate status"] = "Keep"
                why = f"Kept of {len(members)} rows for the same lead: " + ("it has the best number to call" if callable_keep else "it is the most complete")
                if more:
                    why += f"; {_row_list(more)} {'has' if len(more) == 1 else 'have'} a phone this row does not"
                out[index]["Duplicate why"] = why
            else:
                out[index]["Duplicate status"] = f"Duplicate of row {row_numbers[int(keep)]}"
                # Why this row and the kept one are the same lead; a row joined through another says through which.
                direct = between(member, keep)
                if direct is not None and direct["decision"] == "match":
                    out[index]["Duplicate why"] = _why(direct["evidence"])
                else:
                    via = next((other for other in members if other != member and (link := between(member, other)) is not None and link["decision"] == "match"), None)
                    out[index]["Duplicate why"] = (_why(between(member, via)["evidence"]) + f" as row {row_numbers[int(via)]}, a duplicate of the same row") if via else "Same lead"
        if len(examples) < MAX_EXAMPLES:
            examples.append({
                "group": name, "why": out[int(others[0])]["Duplicate why"],
                "rows": [{"row_number": row_numbers[int(member)], "keep": member == keep, "label": _label(rows[int(member)], mapping, normalized[member]["phone"])} for member in [keep, *others][:6]],
                "size": len(members),
            })

    # Pairs the rules could not settle: shown to the person, never grouped.
    possible: dict[str, tuple[float, str]] = {}
    for decision in decisions:
        left, right = decision["left_row_id"], decision["right_row_id"]
        if decision["decision"] != "possible_match" or (cluster_of.get(left) and cluster_of.get(left) == cluster_of.get(right)):
            continue
        chance = decision.get("likelihood")
        if chance is not None and chance < MIN_POSSIBLE:
            continue
        for row_id, other in ((left, right), (right, left)):
            if chance is None or row_id not in possible or (chance or 0.0) > possible[row_id][0]:
                possible[row_id] = (chance or 0.0, other)
    possible_rows = 0
    for row_id, (_chance, other) in possible.items():
        index = int(row_id)
        if out[index]["Duplicate status"]:
            continue  # already settled as kept or as a duplicate; the surer answer stands
        possible_rows += 1
        out[index]["Duplicate status"] = f"Possible duplicate of row {row_numbers[int(other)]}"
        out[index]["Duplicate why"] = _why(between(row_id, other)["evidence"]) + "; not enough to be sure"

    # The same owner at other properties, gathered into one group per owner.
    parent = {row_id: row_id for pair in owner_pairs for row_id in pair}

    def root(row_id: str) -> str:
        while parent[row_id] != row_id:
            parent[row_id] = parent[parent[row_id]]
            row_id = parent[row_id]
        return row_id

    for left, right in owner_pairs:
        parent[root(left)] = root(right)
    owners: dict[str, list[str]] = defaultdict(list)
    for row_id in parent:
        owners[root(row_id)].append(row_id)
    owner_examples: list[dict] = []
    owner_rows = 0
    for members in sorted(owners.values(), key=lambda group: (-len(group), min(int(member) for member in group))):
        members.sort(key=int)
        owner_rows += len(members)
        for member in members:
            out[int(member)]["Same owner rows"] = _row_list([row_numbers[int(other)] for other in members if other != member]).capitalize()
        if len(owner_examples) < MAX_EXAMPLES:
            owner_examples.append({
                "size": len(members),
                "rows": [{"row_number": row_numbers[int(member)], "keep": False, "label": _label(rows[int(member)], mapping, normalized[member]["phone"])} for member in members[:6]],
            })

    used = sorted({role for role in mapping.values()} | {"phone"})
    summary = {
        "version": DUPLICATES_VERSION, "groups": groups, "duplicate_rows": extra, "rows_in_groups": groups + extra, "possible_rows": possible_rows,
        "owner_groups": len(owners), "owner_rows": owner_rows, "examples": examples, "owner_examples": owner_examples,
        "compared_pairs": compared, "ignored_shared_values": ignored, "skipped_groups": block_metrics["oversized_block_count"],
        "uses": used, "has_names": any(role in ("name", "first_name", "last_name") for role in mapping.values()), "has_address": "address" in mapping.values(),
    }
    return out, summary
