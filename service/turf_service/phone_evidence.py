"""Dated, number-specific call logs; a wrong person is scoped to the selected person."""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

from turf_matching import skiptrace as engine
from .storage import utc_now

OUTCOMES = {'reached', 'wrong_person', 'disconnected', 'voicemail', 'no_answer', 'wrong_number'}


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
    except (ValueError, TypeError):
        raise ValueError('Use a valid call date and time') from None
    if parsed > datetime.now(timezone.utc):
        raise ValueError('A call outcome cannot be dated in the future')
    return parsed.isoformat()


def list_events(store, number=None, limit=100, offset=0):
    return [dict(row) for row in store._connection.execute(
        'SELECT * FROM phone_outcomes WHERE (? IS NULL OR number=?) ORDER BY occurred_at DESC, recorded_at DESC LIMIT ? OFFSET ?',
        (number, number, max(1, min(int(limit), 500)), max(0, int(offset))))]


def record(store, payload):
    number = str(payload.get('number') or '')
    infos = engine.read_cell(number, 'US')
    if len(infos) != 1 or not infos[0].valid or infos[0].e164 != number:
        raise ValueError('Choose one valid phone number in international format')
    outcome = payload.get('outcome')
    if outcome not in OUTCOMES:
        raise ValueError('Choose a supported call outcome')
    occurred = timestamp(payload.get('occurred_at') or utc_now())
    person = None
    dataset_id, row_number = payload.get('dataset_id'), payload.get('row_number')
    if dataset_id is not None:
        dataset = store._connection.execute('SELECT * FROM datasets WHERE id=?', (dataset_id,)).fetchone()
        row = store._connection.execute('SELECT raw_values_json FROM source_rows WHERE dataset_id=? AND source_row_number=?', (dataset_id, row_number)).fetchone()
        if dataset is None or row is None:
            raise ValueError('The source row is no longer in this project')
        raw = json.loads(row[0])
        from .skiptrace import get_settings
        config = get_settings(store, dataset_id) or json.loads(dataset['derivation_json'] or '{}').get('config')
        if config is None:
            from .skiptrace import suggest
            config = suggest(store, dataset_id)['config']
        country, source = engine._row_country(raw, config)
        numbers = {info.e164 for column in config['phone_columns'] for info in engine.read_cell(raw.get(column), config['region'], country, source) if info.valid}
        if number not in numbers:
            raise ValueError('Choose a phone number that belongs to this source row')
        people = set()
        for column in config['phone_columns']:
            if any(info.valid and info.e164 == number for info in engine.read_cell(raw.get(column), config['region'], country, source)):
                person_key, _ = engine.person_keys(raw, engine.owner_config(config, column))
                people.add(person_key)
        person = next(iter(people)) if len(people) == 1 else None
    if outcome == 'wrong_person' and not person:
        raise ValueError('Wrong person needs a source row with mapped name columns; use wrong number for unscoped evidence')
    if outcome not in ('wrong_person', 'reached'):
        person = None
    notes = str(payload.get('notes') or '').strip()
    if len(notes) > 2000:
        raise ValueError('Call notes must be 2,000 characters or fewer')
    event_id = str(uuid.uuid4())
    with store._connection:
        store._connection.execute('INSERT INTO phone_outcomes(id,number,outcome,occurred_at,recorded_at,dataset_id,row_number,person_key,notes) VALUES (?,?,?,?,?,?,?,?,?)',
                                  (event_id, number, outcome, occurred, utc_now(), dataset_id, row_number, person, notes))
    return {'id': event_id, 'number': number, 'outcome': outcome, 'occurred_at': occurred}


def retract(store, event_id):
    with store._connection:
        changed = store._connection.execute('UPDATE phone_outcomes SET retired_at=? WHERE id=? AND retired_at IS NULL', (utc_now(), event_id)).rowcount
    if not changed:
        raise ValueError('This call record does not exist or was already retracted')
    return {'id': event_id, 'retracted': True}


def evidence(store):
    return [dict(row) for row in store._connection.execute('SELECT * FROM phone_outcomes WHERE retired_at IS NULL ORDER BY occurred_at, recorded_at')]
