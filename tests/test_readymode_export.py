"""A ReadyMode call log report, as the dialer exports it, is read without the person mapping each status.

The fixture copies the export's columns and its nine Log Type values; the people and numbers in it are made up.
"""
import json
from pathlib import Path

from helpers import ok
from test_service_skiptrace import run, service  # noqa: F401

FIXTURE = Path(__file__).parent / 'fixtures' / 'readymode_call_log.csv'
MEANINGS = {
    'wrong number': ['wrong_number'], 'voicemail': ['voicemail'], 'not interested': ['reached'], 'dead call': ['no_answer'],
    'not available': ['no_answer'], 'transfer': ['reached'], 'do not call': ['do_not_call'], 'callback': ['reached'],
    'spanish speaker': ['reached'],
}


def suggested(service):
    dataset = run(service, 'dataset.import', path=str(FIXTURE))['dataset_id']
    return dataset, ok(service, 'skiptrace.suggest', dataset_id=dataset)


def test_readymode_columns_are_recognised(service):
    _, found = suggested(service)
    config = found['config']
    assert found['outcome_column'] == 'Log Type'
    assert config['phone_columns'] == ['Phone', *(f'Ph#{n}' for n in range(2, 11))]
    assert config['call_date_column'] == 'Log Time'
    # "Agent name" is the dialer's user, never the person called.
    assert config['name_column'] is None
    assert (config['first_name_column'], config['last_name_column'], config['zip_column']) == ('First Name', 'Last Name', 'Zip Code')


def test_every_readymode_log_type_is_settled_by_the_rules(service):
    _, found = suggested(service)
    readings = {status['key']: status for status in found['statuses']}
    assert set(readings) == set(MEANINGS)
    for key, outcomes in MEANINGS.items():
        assert readings[key]['sure'] and readings[key]['outcomes'] == outcomes, key


def test_readymode_call_history_keeps_each_call_and_its_time(service):
    dataset, found = suggested(service)
    config = found['config']
    config['outcome'] = {'column': 'Log Type', 'called_column': 'Phone', 'map': {status['key']: status['outcomes'] for status in found['statuses']}}
    config = ok(service, 'skiptrace.save_settings', dataset_id=dataset, config=config)
    report = run(service, 'skiptrace.scan', dataset_id=dataset, config=config)['report']
    by_number = {}
    for row in report['preview']:
        for choice in json.loads(row['raw']['Phone choices']):
            by_number.setdefault(choice['number'], choice)
    # ReadyMode writes 0 in its unused Ph# slots: an empty slot, not a wrong number.
    assert None not in by_number
    assert report['outcomes']['rows'] == {'do_not_call': 1, 'no_answer': 2, 'reached': 4, 'tried': 11, 'voicemail': 2, 'wrong_number': 2}
    # Called three times: two voicemails, then the person said it is the wrong number.
    repeated = by_number['+17165553102']
    assert repeated['last_outcome']['outcome'] == 'wrong_number'
    assert repeated['last_outcome']['occurred_at'] == '2026-09-30T18:07:00+00:00'
    assert repeated['quality'] == 'wrong' and repeated['blocked']
    assert by_number['+17165553107']['blocked']  # Do Not Call
    assert not by_number['+17165553106']['blocked']  # Transfer: a person answered and went to Appointments
    assert not by_number['+17165553104']['blocked']  # Dead Call is activity only, not a bad number
