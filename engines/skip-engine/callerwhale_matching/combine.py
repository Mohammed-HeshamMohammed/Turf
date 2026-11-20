"""Several lists made into one: each lead once, with what every list has for it.

Caller Whale's own. The rows of all the lists are compared together, with the same rules as the repeated leads of one list
(duplicates.py), so a lead that is in two lists under different spellings is one lead, and one owner with several
properties stays several rows. Each list is read with its own Skip Tracing setup, so the lists need not have the
same columns or the same names for them.

What comes out is chosen by the person: every lead once, only the leads that are in more than one list or in all of
them, or only the leads of one list that no other list has. No list is changed; the result is a new list.
"""

from __future__ import annotations

import re
from typing import Callable

from . import duplicates
from .normalize import email, phone_keys

COMBINE_VERSION = 1
ADDED_COLUMNS = ("Other phones", "Other emails", "In lists", "Combined from")
MAX_EXAMPLES = 25
# Roles one column holds for a row: two lists' columns with the same one are the same column, whatever their names.
_SINGLE = frozenset({"name", "first_name", "last_name", "address", "city", "region", "postal_code", "mailing_address"})


def _header(column: str) -> str:
    return re.sub(r"[^a-z0-9]", "", column.casefold())


def column_plan(lists: list[dict], mappings: list[dict[str, str]]) -> tuple[list[str], list[dict[str, str]], set[str]]:
    """The combined list's columns, where each list's columns go in it, and which of them hold phones or emails.

    Columns meet by name (however it is capitalised or spaced), then by what they are: one list's "Owner" and
    another's "Owner Name" are one column, and the first phone column of each list is the same column.
    """
    columns: list[str] = []
    by_header: dict[str, str] = {}
    by_role: dict[str, str] = {}
    contacts: dict[str, list[str]] = {"phone": [], "email": []}
    plans: list[dict[str, str]] = []

    def new(column: str, source: str) -> str:
        name = column if column not in columns and column not in ADDED_COLUMNS else f"{column} ({source})"
        columns.append(name)
        return name

    for item, mapping in zip(lists, mappings):
        plan: dict[str, str] = {}
        seen = {"phone": 0, "email": 0}
        for column in item["columns"]:
            role = mapping.get(column)
            if role in contacts:
                position, seen[role] = seen[role], seen[role] + 1
                if position >= len(contacts[role]):
                    contacts[role].append(new(column, item["name"]))
                target = contacts[role][position]
            elif _header(column) in by_header:
                target = by_header[_header(column)]
            elif role in _SINGLE and role in by_role:
                target = by_role[role]
            else:
                target = new(column, item["name"])
            if role in _SINGLE:
                by_role.setdefault(role, target)
            by_header.setdefault(_header(column), target)
            plan[column] = target
        plans.append(plan)
    return columns, plans, set(contacts["phone"]) | set(contacts["email"])


def combine(
    lists: list[dict], mode: str = "all", same: list[tuple[tuple[int, int], tuple[int, int]]] = (),
    different: list[tuple[tuple[int, int], tuple[int, int]]] = (), checkpoint: Callable[[], None] | None = None,
    progress: Callable[[str, dict], None] | None = None,
) -> tuple[list[str], list[dict], dict]:
    """Returns (the combined list's columns, its rows, what was found).

    Each of `lists` is {"name", "rows", "numbers", "config", "checked" (or None)}. `same` and `different` are pairs
    the person decided, each row given as (position of its list, its row number).
    """
    checkpoint = checkpoint or (lambda: None)
    progress = progress or (lambda stage, detail: None)
    progress("reading_lists", {})
    normalized: dict[str, dict] = {}
    order: list[str] = []
    mappings: list[dict[str, str]] = []
    id_of: dict[tuple[int, int], str] = {}
    for at, item in enumerate(lists):
        item["columns"] = list(dict.fromkeys(column for row in item["rows"][:400] for column in row))
        listed, mapping = duplicates.normalize_list(item["rows"], item["config"], item.get("checked"), checkpoint)
        # Phones read from a check are phones all the same, for placing the columns.
        mappings.append({**mapping, **{column: "phone" for column in item["config"].get("phone_columns") or [] if column in item["columns"]}})
        for index, n in enumerate(listed):
            row_id = f"{at}:{index}"
            normalized[row_id] = n
            order.append(row_id)
            id_of[(at, item["numbers"][index])] = row_id

    def decided(pairs) -> list[tuple[str, str]]:
        return [(id_of[left], id_of[right]) for left, right in pairs if left in id_of and right in id_of]

    found = duplicates.resolve(normalized, order, decided(same), decided(different), checkpoint, progress)
    progress("writing_combined_list", {})

    def place(row_id: str) -> tuple[int, int]:
        at, index = row_id.split(":")
        return int(at), int(index)

    def rank(row_id: str) -> tuple:
        at, index = place(row_id)
        item = lists[at]
        return duplicates._rank(item["rows"][index], item["checked"][index] if item.get("checked") else None, item["numbers"][index], at, bool(normalized[row_id]["phone"]))

    def label(row_id: str) -> dict:
        at, index = place(row_id)
        item = lists[at]
        return {"list": at, "row_number": item["numbers"][index], "label": duplicates._label(item["rows"][index], mappings[at], normalized[row_id]["phone"])}

    grouped = {row_id for members in found.groups for row_id in members}
    leads = [*found.groups, *([row_id] for row_id in order if row_id not in grouped)]
    position = {row_id: index for index, row_id in enumerate(order)}
    leads.sort(key=lambda members: min(position[row_id] for row_id in members))

    count = len(lists)
    per_list = [{"name": item["name"], "rows": len(item["rows"]), "leads": 0, "only_here": 0, "elsewhere": 0} for item in lists]
    counts = {"all": len(leads), "shared": 0, "in_all": 0, "only": [0] * count}
    wanted: list[tuple[list[str], set[int]]] = []
    examples: list[dict] = []
    for members in leads:
        sources = {place(row_id)[0] for row_id in members}
        for at in sources:
            per_list[at]["leads"] += 1
            per_list[at]["only_here" if len(sources) == 1 else "elsewhere"] += 1
        counts["shared"] += len(sources) > 1
        counts["in_all"] += len(sources) == count
        if len(sources) == 1:
            counts["only"][next(iter(sources))] += 1
        if len(sources) > 1 and len(examples) < MAX_EXAMPLES:
            keep = min(members, key=rank)
            others = sorted((member for member in members if member != keep), key=rank)
            examples.append({"why": found.why(others[0], keep, members), "size": len(members), "rows": [label(row_id) for row_id in [keep, *others][:6]]})
        chosen = (
            mode == "all" or (mode == "shared" and len(sources) > 1) or (mode == "in_all" and len(sources) == count)
            or (mode.startswith("only:") and sources == {int(mode.split(":", 1)[1])})
        )
        if chosen:
            wanted.append((members, sources))

    possible: list[dict] = []
    seen: set[frozenset] = set()
    for row_id, (_chance, other) in found.possible.items():
        pair = frozenset((row_id, other))
        if pair in seen or place(row_id)[0] == place(other)[0]:
            continue
        seen.add(pair)
        if len(possible) < MAX_EXAMPLES:
            possible.append({"why": duplicates._why(duplicates.compare(normalized[row_id], normalized[other])[0]) + "; not enough to be sure", "size": 2, "rows": [label(row_id), label(other)]})

    # The same property under another owner in another list: sold since, or one list has the owner wrong. Rows the
    # rules kept apart for their different names, gathered back by the property alone.
    lead_of = {row_id: index for index, members in enumerate(leads) for row_id in members}
    properties: dict[tuple, dict[int, str]] = {}
    for row_id in order:
        n = normalized[row_id]
        found_address = n.get("address")
        if found_address and found_address["house_number"] and found_address["street"] and n.get("postal_code") and n.get("words"):
            key = (found_address["house_number"], found_address["street"], found_address["unit"], n["postal_code"])
            properties.setdefault(key, {}).setdefault(place(row_id)[0], row_id)
    owner_differs: list[dict] = []
    differing = 0
    for by_list in properties.values():
        firsts = list(by_list.values())
        if len(firsts) < 2 or len({lead_of[row_id] for row_id in firsts}) < 2:
            continue
        if any(normalized[left]["words"] & normalized[right]["words"] for at, left in enumerate(firsts) for right in firsts[at + 1:]):
            continue
        differing += 1
        if len(owner_differs) < MAX_EXAMPLES:
            owner_differs.append({"why": "Same property, another owner", "size": len(firsts), "rows": [label(row_id) for row_id in firsts]})

    columns, plans, contact_columns = column_plan(lists, mappings)
    regions = [str(item["config"].get("region") or "US") for item in lists]
    out: list[dict] = []
    for count_done, (members, sources) in enumerate(wanted):
        if count_done % 2000 == 0:
            checkpoint()
        ordered = sorted(members, key=rank)
        keep = ordered[0]
        row = dict.fromkeys(columns, "")
        # What the row already says, so a number or address another row adds is told from one it repeats.
        phones, emails = set(normalized[keep]["phone"]), set(normalized[keep]["email"])
        for row_id in ordered:
            at, index = place(row_id)
            for column, value in lists[at]["rows"][index].items():
                target = plans[at].get(column)
                # A cell is filled from the kept row first, then from the others where it is still empty. Nothing
                # the kept row says is replaced.
                if target is None or value in (None, "") or row[target] not in (None, ""):
                    continue
                row[target] = value
                if target in contact_columns and row_id != keep:
                    phones |= phone_keys(value, regions[at])
                    emails |= {found for found in (email(part) for part in str(value).replace(";", " ").replace(",", " ").split()) if found}
        others = ordered[1:]
        # A phone or email of another row that found no empty cell is kept beside the row's own, not dropped.
        row["Other phones"] = "; ".join(sorted({phone for row_id in others for phone in normalized[row_id]["phone"]} - phones))
        row["Other emails"] = "; ".join(sorted({found for row_id in others for found in normalized[row_id]["email"]} - emails))
        row["In lists"] = "; ".join(lists[at]["name"] for at in sorted(sources))
        shown = [f"{lists[place(row_id)[0]]['name']} row {lists[place(row_id)[0]]['numbers'][place(row_id)[1]]}" for row_id in ordered[:10]]
        row["Combined from"] = "; ".join(shown) + (f"; and {len(ordered) - 10} more" if len(ordered) > 10 else "")
        out.append(row)

    summary = {
        "version": COMBINE_VERSION, "mode": mode, "lists": per_list, "counts": counts, "rows_out": len(out), "rows_in": len(order),
        "repeats_within": sum(len({place(row_id)[0] for row_id in members}) < len(members) for members in found.groups),
        "examples": examples, "possible": possible, "owner_differs": differing, "owner_differs_examples": owner_differs, "possible_pairs": len(seen), "compared_pairs": found.compared, "overruled": found.overruled,
        "ignored_shared_values": found.ignored,
    }
    return [*columns, *ADDED_COLUMNS], out, summary
