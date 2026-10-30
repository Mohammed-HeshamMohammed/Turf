"""Dialer call results work as project evidence without provider credentials."""
import json

import pytest

from helpers import call, ok
from test_service_skiptrace import FILE_A, confirmed, make_dataset, run, service  # noqa: F401


def imported(service, tmp_path, content, mapping):
    path = tmp_path / 'dialer.csv'
    path.write_text(content, encoding='utf-8')
    dataset = run(service, 'dataset.import', path=str(path))['dataset_id']
    config = ok(service, 'skiptrace.suggest', dataset_id=dataset)['config']
    config.update(phone_columns=['Phone'], name_column='Name', call_date_column='Call Time', outcome={'column': 'Result', 'called_column': 'Phone', 'map': mapping})
    config = ok(service, 'skiptrace.save_settings', dataset_id=dataset, config=config)
    return dataset, config


def choices(report, row=0):
    return json.loads(report['preview'][row]['raw']['Phone choices'])


def test_dialer_wrong_person_matches_named_lead_without_export_zip_and_preserves_timestamp(service, tmp_path, monkeypatch):
    from callerwhale_service import phone_lookup
    monkeypatch.setattr(phone_lookup, 'fetch_number', lambda *args: pytest.fail('Dialer exports need no lookup requests'))
    lead = make_dataset(service, tmp_path, 'Leads', [FILE_A[0], ['Bo', 'Reyes', '7135553142', '', '77009', 'TX', 'Not yet reached']])
    config = confirmed(service, lead)
    exported, _ = imported(service, tmp_path, 'Name,Phone,Result,Call Time\nAna Lopez,7135553142,Wrong person,2026-10-08T15:30:20+03:00\nBo Reyes,7135553142,No answer,2026-10-08T16:00:00+03:00\n', {'wrong person': ['wrong_person'], 'no answer': ['no_answer']})
    before = ok(service, 'dataset.rows', dataset_id=lead)
    report = run(service, 'skiptrace.scan', dataset_id=lead, config=config)['report']
    ana = next(choice for choice in choices(report) if choice['number'] == '+17135553142')
    assert ana['quality'] == 'wrong' and ana['blocked']
    assert report['row_counts']['known_wrong'] == 1
    assert choices(report, 1)[0]['quality'] != 'wrong'
    # The lead's last result can be later global activity; inspect the export's actual wrong-person event directly.
    from callerwhale_service.skiptrace import _knowledge, _dataset
    from callerwhale_service.cleaning import _rows
    source_config = ok(service, 'skiptrace.suggest', dataset_id=exported)['config']
    _, rows = _rows(service.store, exported)
    knowledge, _ = _knowledge(service.store, service.project['id'], _dataset(service.store, exported), source_config, rows)
    event = next(event for event in knowledge.events['+17135553142'] if event['outcome'] == 'wrong_person')
    assert event['occurred_at'] == '2026-10-08T12:30:20+00:00'
    assert ok(service, 'dataset.rows', dataset_id=lead) == before
    assert ok(service, 'phone.lookup_history') == []
    assert not ok(service, 'phone.lookup_settings')['enabled']


@pytest.mark.parametrize('status,outcome,quality,blocked', [('No answer', 'no_answer', 'unverified', False), ('Left voicemail', 'voicemail', 'unverified', False), ('Disconnected', 'disconnected', 'wrong', True)])
def test_dialer_activity_and_disconnection_meanings_are_preserved(service, tmp_path, status, outcome, quality, blocked):
    export, config = imported(service, tmp_path, f'Name,Phone,Result,Call Time\nAna Lopez,7135553142,{status},2026-10-08T12:34:56Z\n', {status.casefold(): [outcome]})
    report = run(service, 'skiptrace.scan', dataset_id=export, config=config)['report']
    choice = choices(report)[0]
    assert choice['quality'] == quality and choice['blocked'] is blocked
    assert choice['last_outcome']['outcome'] == outcome
    assert choice['last_outcome']['occurred_at'] == '2026-10-08T12:34:56+00:00'


def test_wrong_person_mapping_requires_names_and_cannot_also_mean_reached(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Validation', [FILE_A[0]])
    config = confirmed(service, dataset)
    config['outcome']['map'] = {'not yet reached': ['wrong_person']}
    no_names = {**config, 'name_column': None, 'first_name_column': None, 'last_name_column': None}
    assert 'name columns' in call(service, 'skiptrace.save_settings', dataset_id=dataset, config=no_names)['error']['message']
    config['outcome']['map'] = {'not yet reached': ['wrong_person', 'reached']}
    assert not call(service, 'skiptrace.save_settings', dataset_id=dataset, config=config)['ok']
