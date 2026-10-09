"""Explainable phone choices added alongside the unchanged legacy verdicts."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import replace
from datetime import date, datetime


def shared_context(rows, config, engine):
    found = defaultdict(list)
    for row in rows:
        who, family = engine.person_keys(row, config)
        country, source = engine._row_country(row, config)
        address = engine._clean(row.get(config.get('address_column') or '')).casefold()
        postal = engine._clean(row.get(config.get('zip_column') or '')).casefold()
        company = engine._clean(row.get(config.get('business_column') or '')).casefold()
        for column in config['phone_columns']:
            for info in engine.read_cell(row.get(column), config.get('region') or 'US', country, source):
                if info.valid and info.e164:
                    found[info.e164].append((who, family, (address, postal) if address else None, company, info.business_line))
    result = {}
    for number, entries in found.items():
        people = {entry[0] for entry in entries if entry[0]}
        addresses = {entry[2] for entry in entries if entry[2]}
        companies = {entry[3] for entry in entries if entry[3]}
        families = {entry[1] for entry in entries if entry[1]}
        kind, explanation = 'not_shared', 'No distinct people sharing this number were identified'
        if len(people) > 1:
            same_address = len(addresses) == 1 and all(entry[2] for entry in entries)
            same_family = families and engine.count_families(list(families)) == 1 and all(entry[1] for entry in entries)
            if (len(companies) == 1 and all(entry[3] for entry in entries)) or any(entry[4] for entry in entries):
                kind, explanation = 'possible_business', 'Possible shared business line; company or number-type evidence matches'
            elif same_address or same_family:
                kind, explanation = 'possible_household', 'Possible household number; address or family-name evidence matches'
            else:
                kind, explanation = 'unrelated_people', 'Different names with no shared household or business evidence'
        elif len(entries) > 1 and not people:
            kind, explanation = 'unknown', 'Number repeats, but name columns are missing; relationship is unknown'
        result[number] = {'kind': kind, 'people': len(people), 'explanation': explanation}
    return result


def assess(info, column, row, config, context, shared, engine):
    # DNC affects permission only here. The legacy combined verdict is retained separately.
    knowledge = context['knowledge']
    quality_context = {**context, 'knowledge': replace(knowledge, dnc={})}
    quality, reasons = engine.judge(info, row, config, quality_context)
    number = info.e164
    sharing = shared.get(number, {'kind': 'unknown', 'people': 0, 'explanation': 'No relationship evidence'})
    if sharing['kind'] in ('possible_household', 'possible_business'):
        reasons = [reason for reason in reasons if reason['code'] != 'shared_number']
        effects = {reason['effect'] for reason in reasons}
        quality = 'wrong' if 'wrong' in effects else 'corroborated' if 'corroborated' in effects else 'suspicious' if 'suspicious' in effects else 'unverified'
    active_dnc = any(until is None or until >= context['today'] for _, until in knowledge.dnc.get(number, []))
    events = [event for event in knowledge.events.get(number, []) if not event.get('person_key') or event['person_key'] == context['who']]
    events = sorted(events, key=lambda event: event.get('occurred_at') or '')
    positive = [event for event in events if event['outcome'] == 'reached']
    negative = [event for event in events if event['outcome'] in ('wrong_number', 'wrong_person', 'disconnected')]
    dated_positive = [event for event in positive if event.get('occurred_at')]
    dated_negative = [event for event in negative if event.get('occurred_at')]
    warnings = []
    age_days = config.get('evidence_age_days', 180)
    last_success = dated_positive[-1]['occurred_at'] if dated_positive else None
    if last_success and (context['today'] - date.fromisoformat(last_success[:10])).days >= age_days:
        warnings.append(f'Last successful call is at least {age_days} days old ({last_success[:10]}); review before relying on it')
    if positive and not dated_positive:
        warnings.append('Successful-call evidence has no call date; its age is unknown')
    if positive and negative:
        warnings.append('Conflicting call history; possible reassignment or incorrect person association, not confirmed')
        if dated_positive and dated_negative and dated_negative[-1]['occurred_at'] > dated_positive[-1]['occurred_at']:
            warnings.append(f"A negative outcome on {dated_negative[-1]['occurred_at'][:10]} is newer than the last successful call")
        if info.valid:
            quality = 'suspicious'
    elif negative and info.valid:
        quality = 'wrong'
    elif positive and info.valid and quality != 'wrong':
        quality = 'corroborated'
    last_event = events[-1] if events else None
    lookup = knowledge.lookups.get(number)
    if lookup:
        checked = lookup['checked_at']
        lookup = {**lookup, 'stale': (context['today'] - date.fromisoformat(checked[:10])).days >= config.get('lookup_age_days', 30)}
        if lookup['stale']:
            warnings.append(f'Live lookup from {checked[:10]} is old; refresh it before relying on it')
        if lookup.get('line_status') == 'inactive':
            warnings.append('Provider reports an inactive line; review availability before calling')
        elif lookup.get('line_status') == 'unreachable':
            warnings.append('Provider reports a temporarily unreachable handset; this does not mean a wrong number')
        if lookup.get('valid_format') is False:
            warnings.append('Provider format validation disagrees with the local check; review the number')
    explanations = [reason['text'] for reason in reasons]
    if last_event:
        explanations.append(f"{last_event['outcome'].replace('_', ' ')} · {last_event.get('occurred_at') or 'date unknown'} · {last_event['source']}")
    if sharing['kind'] != 'not_shared':
        explanations.append(sharing['explanation'])
    explanations += warnings
    permission = 'blocked_dnc' if active_dnc else 'no_recorded_block'
    blocked = active_dnc or quality == 'wrong' or (lookup and not lookup['stale'] and lookup.get('line_status') == 'inactive')
    if active_dnc:
        explanations.insert(0, 'Do not call: active project DNC evidence')
    return {'number': number, 'raw': info.raw, 'column': column, 'extension': info.extension, 'valid_format': info.valid,
            'quality': quality, 'permission': permission, 'blocked': bool(blocked), 'type': info.type,
            'shared': sharing, 'last_success': last_success, 'last_outcome': last_event, 'warnings': warnings,
            'lookup': lookup, 'explanations': explanations or ['Valid format; connection and ownership are unverified']}


def rank(candidates):
    # Stable order resolves ties using the original column/value order; duplicates retain provenance.
    unique = {}
    for candidate in candidates:
        key = (candidate['number'] or candidate['raw'], candidate.get('extension'))
        if key in unique:
            unique[key]['columns'].append(candidate['column'])
        else:
            unique[key] = {**candidate, 'columns': [candidate['column']]}
    ranks = {'corroborated': 0, 'unverified': 1, 'suspicious': 2, 'wrong': 3}
    choices = sorted(unique.values(), key=lambda item: (item['blocked'], ranks[item['quality']], bool(item['warnings']), -(datetime.fromisoformat(item['last_success']).timestamp() if item.get('last_success') else 0)))
    for index, choice in enumerate(choices):
        choice['rank'] = index + 1
        choice['recommendation'] = 'Blocked' if choice['blocked'] else 'Review before calling' if choice['warnings'] or choice['quality'] == 'suspicious' else 'First choice' if index == 0 else 'Alternative'
    return choices
