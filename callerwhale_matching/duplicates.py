"""Rows that repeat the same lead: in one list, during a phone check, or across lists that are being combined.

Caller Whale's own, built on DataForge's matching engine (engine.py, normalize.py and likelihood.py, copied unchanged): its
candidate groups, field evidence, guarded grouping and likelihood. What Caller Whale adds, because a list of leads is not a
contact file:

- No second setup. The columns come from the Skip Tracing setup, and the phones from the check itself.
- One owner with several properties is not a duplicate. Those rows are told apart and reported as the same owner.
- Names as county rolls and dialers write them: "SMITH JOHN A" and "John Smith" are one name, a company is compared
  without its legal form, and a household ("SMITH JOHN & MARY") is not read as one person.
- An office or placeholder number on many rows under different names is not evidence that two rows are the same lead.
- Two rows for one lead often carry different phones, which is what skip tracing returns; a phone the rows do not
  share says nothing either way, and the same town or ZIP is not a second field to be sure on.
- The row to keep is the one with the best number to call, then the most complete, then the first.
- No group of rows is left out for being large, and the person can overrule any answer: two rows they say are the
  same lead are, and two they say are not never are.

Nothing is removed. Each row is given what it is (keep, duplicate of a row, possibly a duplicate) and why, in columns
the checked copy carries; the person decides what to do with them.
"""

from __future__ import annotations

import re
from collections import Counter, defaultdict
from itertools import combinations
from typing import Callable

from . import engine, likelihood
from .cleanup import company_key
from .normalize import normalize_row, phone_keys, text

DUPLICATES_VERSION = 2
COLUMNS = ("Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows")
STRICTNESS = "conservative"
# Inside a candidate group of up to this many rows every pair is compared; a larger one is gone through more narrowly.
FULL_GROUP = 60
NEIGHBOURS = 5
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


def normalize_list(rows: list[dict], config: dict, checked: list[dict] | None = None, checkpoint: Callable[[], None] | None = None) -> tuple[list[dict], dict[str, str]]:
    """Each row as the engine compares it, and what each column is.

    `checked` is each row as the phone check wrote it (its numbers in international form, its best phone and that
    phone's verdict); without it the phones are read from the setup's phone columns.
    """
    columns = list(dict.fromkeys(column for row in rows[:400] for column in row))
    mapping = roles(config, columns)
    region = str(config.get("region") or "US")
    phone_columns = [column for column in config.get("phone_columns") or [] if column in columns]
    if checked is None:
        mapping = {**mapping, **{column: "phone" for column in phone_columns}}
    normalized = []
    for index, row in enumerate(rows):
        if checkpoint and index % 2000 == 0:
            checkpoint()
        phones: set[str] | None = None
        if checked is not None:
            phones = set()
            for column in phone_columns:
                read = {number.strip() for number in str(checked[index].get(f"{column} (E.164)") or "").split(";") if number.strip()}
                # A number the check could not read as valid is still the same number when two rows carry it.
                phones |= read or phone_keys(row.get(column), region)
        normalized.append(_normalize(row, mapping, region, phones))
    return normalized, mapping


def _signature(n: dict) -> tuple | None:
    """What a row is compared by, whole. Rows with the same signature are the same row written again."""
    signature = (
        frozenset(n["phone"]), frozenset(n["email"]), n.get("words") or n.get("name") or "", (n.get("address") or {}).get("full", ""),
        (n.get("mailing_address") or {}).get("full", ""),
    )
    return (*signature, n.get("postal_code") or "", n.get("city") or "") if any(signature) else None


def _second_keys(n: dict) -> set[str]:
    """What else two rows of one large group can share, to be worth comparing."""
    keys = {f"p:{value}" for value in n["phone"]} | {f"e:{value}" for value in n["email"]}
    for role, prefix in (("address", "a"), ("mailing_address", "m")):
        parsed = n.get(role)
        if parsed:
            keys.add(f"{prefix}:{parsed['house_number'] or parsed['full']}")
    if n.get("words"):
        keys.add("w:" + " ".join(sorted(n["words"])))
    return keys


def _candidates(normalized: dict[str, dict], ids: list[str], checkpoint: Callable[[], None]) -> tuple[set[tuple[str, str]], int]:
    """The pairs of rows worth comparing, and how many large groups were gone through the narrower way.

    Rows are compared only when they share something: a phone, an email, a street number and street, a name in one
    ZIP. Inside a group of up to FULL_GROUP rows every pair is compared. A larger group (a common name in a big
    ZIP, a tower of flats at one address) is not left out, as it would be in DataForge, and not compared pair by
    pair either, which would take minutes: its rows are compared when they share a second thing, and each with its
    nearest neighbours by name and address. The work grows with the number of rows, not with its square.
    """
    blocks: dict[str, list[str]] = defaultdict(list)
    for count, row_id in enumerate(ids):
        if count % 5000 == 0:
            checkpoint()
        for key in set(engine._block_keys(normalized[row_id], True)):
            blocks[key].append(row_id)
    pairs: set[tuple[str, str]] = set()

    def every(members: list[str]) -> None:
        pairs.update(combinations(sorted(members), 2))

    def neighbours(members: list[str]) -> None:
        ordered = sorted(members, key=lambda row_id: (" ".join(sorted(normalized[row_id].get("words") or ())), (normalized[row_id].get("address") or {}).get("full", ""), row_id))
        for at, left in enumerate(ordered):
            for right in ordered[at + 1:at + 1 + NEIGHBOURS]:
                pairs.add((left, right) if left < right else (right, left))

    narrowed = 0
    for count, members in enumerate(blocks.values()):
        if len(members) < 2:
            continue
        if count % 2000 == 0:
            checkpoint()
        if len(members) <= FULL_GROUP:
            every(members)
            continue
        narrowed += 1
        inner: dict[str, list[str]] = defaultdict(list)
        for row_id in members:
            for key in _second_keys(normalized[row_id]):
                inner[key].append(row_id)
        for group in inner.values():
            # A second value the whole group shares tells nothing more than the group itself.
            if 2 <= len(group) < len(members):
                (every if len(group) <= FULL_GROUP else neighbours)(group)
        neighbours(members)
    return pairs, narrowed


class Resolution:
    """Which rows are the same lead, which might be, and which are one owner with several properties."""

    def __init__(self, normalized: dict[str, dict]) -> None:
        self.normalized = normalized
        self.groups: list[list[str]] = []
        self.possible: dict[str, tuple[float, str]] = {}
        self.owners: list[list[str]] = []
        self.said_same: set[frozenset] = set()
        self.compared = self.ignored = self.narrowed = self.overruled = 0

    def why(self, member: str, keep: str, members: list[str]) -> str:
        """Why a row and the kept one are the same lead; a row joined through another says through which."""
        if frozenset((member, keep)) in self.said_same:
            return "You said these are the same lead"
        evidence = compare(self.normalized[member], self.normalized[keep])[0]
        if not any(item["strength"] == "guard" for item in evidence) and any(item["result"] in ("exact", "similar") and item["field"] in _FIELD_LABELS for item in evidence):
            return _why(evidence)
        for other in members:
            if other in (member, keep):
                continue
            if frozenset((member, other)) in self.said_same:
                return "You said this is the same lead as another row of the group"
            through = compare(self.normalized[member], self.normalized[other])[0]
            if not any(item["strength"] == "guard" for item in through) and any(item["strength"] == "strong" for item in through):
                return _why(through) + " as another row of the group"
        return "Same lead"


def resolve(
    normalized: dict[str, dict], order: list[str], same: list[tuple[str, str]] = (), different: list[tuple[str, str]] = (),
    checkpoint: Callable[[], None] | None = None, progress: Callable[[str, dict], None] | None = None,
) -> Resolution:
    """Compares the rows and gathers them into leads. `same` and `different` are pairs the person decided: they are
    followed whatever the rules would say."""
    checkpoint = checkpoint or (lambda: None)
    progress = progress or (lambda stage, detail: None)
    found = Resolution(normalized)
    present = set(order)
    same = [pair for pair in same if pair[0] in present and pair[1] in present and pair[0] != pair[1]]
    different = [pair for pair in different if pair[0] in present and pair[1] in present]
    found.overruled = len(same) + len(different)
    found.said_same = {frozenset(pair) for pair in same}
    apart = {frozenset(pair) for pair in different}
    found.ignored = _ignore_shared(normalized)

    # The same row written again is settled once, not compared with every other copy of itself. A row the person
    # decided about is always looked at on its own.
    decided = {row_id for pair in [*same, *different] for row_id in pair}
    first: dict[tuple, str] = {}
    copies: dict[str, list[str]] = defaultdict(list)
    representatives: list[str] = []
    for row_id in order:
        signature = None if row_id in decided else _signature(normalized[row_id])
        if signature is not None and signature in first:
            copies[first[signature]].append(row_id)
            continue
        if signature is not None:
            first[signature] = row_id
        representatives.append(row_id)

    parent = {row_id: row_id for row_id in order}

    def root(row_id: str) -> str:
        while parent[row_id] != row_id:
            parent[row_id] = parent[parent[row_id]]
            row_id = parent[row_id]
        return row_id

    possible_pairs: list[tuple[float | None, str, str]] = []
    for representative, others in copies.items():
        evidence, score, comparable = compare(normalized[representative], normalized[representative])
        decision, _ = engine.decide(evidence, score, comparable, STRICTNESS)
        for other in others:
            if decision == "match":
                parent[root(other)] = root(representative)
            elif decision == "possible_match":
                possible_pairs.append((None, representative, other))

    pairs, found.narrowed = _candidates(normalized, representatives, checkpoint)
    found.compared = len(pairs)
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
            if _same_owner(evidence) and frozenset((left, right)) not in found.said_same:
                owner_pairs.append((left, right))
            continue
        decisions.append({"id": f"{left}|{right}", "left_row_id": left, "right_row_id": right, "evidence": evidence, "score": round(score, 4), "decision": decision, "reason": reason})
    del pairs

    constraints = [{"left_row_id": left, "right_row_id": right, "kind": "must_not_link"} for left, right in different]
    kept = {row_id: normalized[row_id] for row_id in representatives}
    clusters, bridges, _ = engine.cluster(representatives, kept, decisions, constraints, [], person=True)
    bridged = set(bridges)
    for decision in decisions:
        if decision["id"] in bridged:
            decision["decision"] = "possible_match"
    checkpoint()
    likelihood.annotate(decisions, kept, lambda left, right: compare(left, right)[0])
    for cluster in clusters:
        members = cluster["member_row_ids"]
        for member in members[1:]:
            parent[root(member)] = root(members[0])
    # What the person said is the same lead is, whatever keeps the rules from saying so.
    for left, right in same:
        parent[root(left)] = root(right)

    gathered: dict[str, list[str]] = defaultdict(list)
    for row_id in order:
        gathered[root(row_id)].append(row_id)
    found.groups = [members for members in gathered.values() if len(members) > 1]

    possible_pairs += [(decision.get("likelihood"), decision["left_row_id"], decision["right_row_id"]) for decision in decisions if decision["decision"] == "possible_match"]
    for chance, left, right in possible_pairs:
        if root(left) == root(right) or frozenset((left, right)) in apart or (chance is not None and chance < MIN_POSSIBLE):
            continue
        for row_id, other in ((left, right), (right, left)):
            if row_id not in found.possible or (1.0 if chance is None else chance) > found.possible[row_id][0]:
                found.possible[row_id] = (1.0 if chance is None else chance, other)

    # The same owner at other properties, gathered into one group per owner.
    owner_parent = {row_id: row_id for pair in owner_pairs for row_id in pair}

    def owner_root(row_id: str) -> str:
        while owner_parent[row_id] != row_id:
            owner_parent[row_id] = owner_parent[owner_parent[row_id]]
            row_id = owner_parent[row_id]
        return row_id

    for left, right in owner_pairs:
        if frozenset((left, right)) not in apart:
            owner_parent[owner_root(left)] = owner_root(right)
    owners: dict[str, list[str]] = defaultdict(list)
    for row_id in owner_parent:
        owners[owner_root(row_id)].append(row_id)
    position = {row_id: index for index, row_id in enumerate(order)}
    found.owners = sorted(([*sorted(members, key=position.__getitem__)] for members in owners.values() if len(members) > 1), key=lambda group: (-len(group), position[group[0]]))
    return found


def _rank(row: dict, best: dict | None, row_number: int, source: int = 0, has_phone: bool = True) -> tuple:
    """Which row of a lead is kept: the best number to call, then one with a phone at all, then the most complete,
    then the first."""
    best = best or {}
    filled = sum(1 for value in row.values() if value not in (None, ""))
    return (not best.get("Best phone"), _VERDICT_RANK.get(str(best.get("Best phone verdict") or ""), 4), not has_phone, -filled, source, row_number)


def find(
    rows: list[dict], row_numbers: list[int], config: dict, checked: list[dict] | None = None,
    checkpoint: Callable[[], None] | None = None, progress: Callable[[str, dict], None] | None = None,
    same: list[tuple[int, int]] = (), different: list[tuple[int, int]] = (),
) -> tuple[list[dict], dict]:
    """Returns (one dict of the four duplicate columns for each row, a summary for the report).

    `same` and `different` are pairs of row numbers the person decided are, or are not, the same lead.
    """
    checkpoint = checkpoint or (lambda: None)
    (progress or (lambda stage, detail: None))("finding_duplicates", {})
    listed, mapping = normalize_list(rows, config, checked, checkpoint)
    ids = [str(index) for index in range(len(rows))]
    normalized = dict(zip(ids, listed))
    id_of = {number: ids[index] for index, number in enumerate(row_numbers)}

    def decided(pairs) -> list[tuple[str, str]]:
        return [(id_of[left], id_of[right]) for left, right in pairs if left in id_of and right in id_of]

    found = resolve(normalized, ids, decided(same), decided(different), checkpoint, progress)

    def rank(row_id: str) -> tuple:
        index = int(row_id)
        return _rank(rows[index], checked[index] if checked is not None else None, row_numbers[index], has_phone=bool(normalized[row_id]["phone"]))

    out = [dict.fromkeys(COLUMNS, "") for _ in rows]
    examples: list[dict] = []
    extra = 0
    for count, members in enumerate(found.groups, start=1):
        extra += len(members) - 1
        keep = min(members, key=rank)
        name = f"D{count}"
        others = [member for member in members if member != keep]
        more = [row_numbers[int(member)] for member in others if normalized[member]["phone"] - normalized[keep]["phone"]]
        callable_keep = checked is not None and bool(checked[int(keep)].get("Best phone"))
        for member in members:
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
                out[index]["Duplicate why"] = found.why(member, keep, members)
        if len(examples) < MAX_EXAMPLES:
            examples.append({
                "group": name, "why": out[int(others[0])]["Duplicate why"],
                "rows": [{"row_number": row_numbers[int(member)], "keep": member == keep, "label": _label(rows[int(member)], mapping, normalized[member]["phone"])} for member in [keep, *others][:6]],
                "size": len(members),
            })

    # Pairs the rules could not settle: shown to the person, never grouped.
    possible_rows = 0
    for row_id, (_chance, other) in found.possible.items():
        index = int(row_id)
        if out[index]["Duplicate status"]:
            continue  # already settled as kept or as a duplicate; the surer answer stands
        possible_rows += 1
        out[index]["Duplicate status"] = f"Possible duplicate of row {row_numbers[int(other)]}"
        out[index]["Duplicate why"] = _why(compare(normalized[row_id], normalized[other])[0]) + "; not enough to be sure"

    owner_examples: list[dict] = []
    owner_rows = 0
    for members in found.owners:
        owner_rows += len(members)
        for member in members:
            out[int(member)]["Same owner rows"] = _row_list([row_numbers[int(other)] for other in members if other != member]).capitalize()
        if len(owner_examples) < MAX_EXAMPLES:
            owner_examples.append({
                "size": len(members),
                "rows": [{"row_number": row_numbers[int(member)], "keep": False, "label": _label(rows[int(member)], mapping, normalized[member]["phone"])} for member in members[:6]],
            })

    summary = {
        "version": DUPLICATES_VERSION, "groups": len(found.groups), "duplicate_rows": extra, "rows_in_groups": len(found.groups) + extra, "possible_rows": possible_rows,
        "owner_groups": len(found.owners), "owner_rows": owner_rows, "examples": examples, "owner_examples": owner_examples,
        "compared_pairs": found.compared, "ignored_shared_values": found.ignored, "narrowed_groups": found.narrowed, "overruled": found.overruled,
        "uses": sorted({role for role in mapping.values()} | {"phone"}),
        "has_names": any(role in ("name", "first_name", "last_name") for role in mapping.values()), "has_address": "address" in mapping.values(),
    }
    return out, summary
