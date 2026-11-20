"""Number quality, safe recommendations, dated evidence, and optional provider lookup."""
import json
import os
from datetime import date, datetime, timedelta, timezone
from threading import Event

import pytest

from helpers import call, ok, wait
from test_service_skiptrace import FILE_A, confirmed, make_dataset, run, service  # noqa: F401
from callerwhale_service import phone_lookup


def scan(service, dataset, config):
    return run(service, 'skiptrace.scan', dataset_id=dataset, config=config)['report']


def choices(report, index=0):
    return json.loads(report['preview'][index]['raw']['Phone choices'])


def record(service, number, outcome, dataset=None, row=2, days=0):
    return ok(service, 'phone.record_outcome', number=number, outcome=outcome, dataset_id=dataset, row_number=row,
              occurred_at=(datetime.now(timezone.utc) - timedelta(days=days)).isoformat(), notes='Call note')


def provider(service, **extra):
    return ok(service, 'phone.configure_lookup', account_sid='AC' + 'a' * 32, auth_token='b' * 32,
              enabled=True, unit_cost='0.008', cache_days=30, **extra)


def lookup(service, dataset, config, **extra):
    preview = ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config, **extra)
    result = run(service, 'phone.lookup', dataset_id=dataset, config=config, quote_token=preview['quote_token'], **extra)
    return preview, result


def test_valid_dnc_has_separate_quality_and_never_becomes_a_recommendation(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'DNC', [FILE_A[0]])
    config = confirmed(service, dataset)
    ok(service, 'marks.set', number='+17135553142', mark='do_not_call')
    report = scan(service, dataset, config)
    blocked = next(choice for choice in choices(report) if choice['number'] == '+17135553142')
    assert blocked['quality'] == 'unverified' and blocked['valid_format']
    assert blocked['permission'] == 'blocked_dnc' and blocked['blocked']
    assert report['preview'][0]['raw']['Phone (verdict)'] == 'wrong'  # Legacy data retained.
    assert report['preview'][0]['raw']['Best phone'] == '+17135554455'
    assert choices(report)[0]['recommendation'] == 'First choice'
    assert report['phone_assessments']['blocked_dnc'] == 1


def test_rank_selects_one_unblocked_number_inside_a_multi_number_cell(service, tmp_path):
    row = [*FILE_A[0]]
    row[2], row[3] = '7135553142; 7135554455; 7135554455', '7135554455'
    dataset = make_dataset(service, tmp_path, 'Many phones', [row])
    config = confirmed(service, dataset)
    ok(service, 'marks.set', number='+17135553142', mark='do_not_call')
    report = scan(service, dataset, config)
    assert report['preview'][0]['raw']['Best phone'] == '+17135554455'
    assert len(choices(report)) == 2
    assert choices(report)[0]['columns'] == ['Phone', 'Alt. Phone']
    assert choices(report)[-1]['blocked']


def test_extensions_are_retained_as_distinct_choices(service, tmp_path):
    row = [*FILE_A[0]]
    row[2], row[3] = '7135553142 ext 12', '7135553142 ext 34'
    dataset = make_dataset(service, tmp_path, 'Extensions', [row])
    report = scan(service, dataset, confirmed(service, dataset))
    assert {choice['extension'] for choice in choices(report)} == {'12', '34'}


def test_wrong_person_is_scoped_and_retraction_retains_audit_history(service, tmp_path):
    rows = [FILE_A[0], ['Bo', 'Reyes', '7135553142', '', '77009', 'TX', 'Not yet reached']]
    dataset = make_dataset(service, tmp_path, 'People', rows)
    config = confirmed(service, dataset)
    event = record(service, '+17135553142', 'wrong_person', dataset)
    report = scan(service, dataset, config)
    ana = next(choice for choice in choices(report) if choice['number'] == '+17135553142')
    bo = choices(report, 1)[0]
    assert ana['quality'] == 'wrong' and ana['blocked']
    assert bo['quality'] != 'wrong' and not bo['blocked']
    assert report['row_counts']['known_wrong'] == 1
    ok(service, 'phone.retract_outcome', id=event['id'])
    history = ok(service, 'phone.outcomes', number='+17135553142')
    assert history[0]['retired_at'] and history[0]['notes'] == 'Call note'
    assert next(choice for choice in choices(scan(service, dataset, config)) if choice['number'] == '+17135553142')['quality'] != 'wrong'


@pytest.mark.parametrize('outcome', ['voicemail', 'no_answer'])
def test_non_answers_are_activity_not_negative_evidence(service, tmp_path, outcome):
    dataset = make_dataset(service, tmp_path, outcome, [FILE_A[0]])
    config = confirmed(service, dataset)
    record(service, '+17135553142', outcome, dataset)
    choice = choices(scan(service, dataset, config))[0]
    assert choice['quality'] == 'unverified' and not choice['blocked']
    assert choice['last_outcome']['outcome'] == outcome


def test_disconnected_blocks_number_everywhere_and_does_not_block_alternatives(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Disconnected', [FILE_A[0]])
    config = confirmed(service, dataset)
    record(service, '+17135553142', 'disconnected', dataset)
    report = scan(service, dataset, config)
    assert choices(report)[-1]['quality'] == 'wrong'
    assert report['preview'][0]['raw']['Best phone'] == '+17135554455'
    other = make_dataset(service, tmp_path, 'Other person', [['Bo', 'Reyes', '7135553142', '', '77009', 'TX', 'Not yet reached']])
    other_report = scan(service, other, confirmed(service, other))
    assert choices(other_report)[0]['blocked'] and other_report['rows_with_callable_number'] == 0


def test_old_success_and_newer_conflict_raise_review_without_claiming_reassignment(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Aging', [FILE_A[0]])
    config = confirmed(service, dataset)
    record(service, '+17135553142', 'reached', dataset, days=200)
    before = scan(service, dataset, config)
    positive = choices(before)[0]
    assert positive['quality'] == 'corroborated'
    assert any('180 days old' in warning for warning in positive['warnings'])
    record(service, '+17135553142', 'wrong_person', dataset, days=1)
    report = scan(service, dataset, config)
    conflict = next(choice for choice in choices(report) if choice['number'] == '+17135553142')
    assert conflict['quality'] == 'suspicious'
    assert any('not confirmed' in warning for warning in conflict['warnings'])
    assert any('newer' in warning for warning in conflict['warnings'])
    assert report['row_counts']['needs_review'] == 1
    saved = run(service, 'skiptrace.apply', dataset_id=dataset, config=config, scan_job_id=report['scan_job_id'])
    lineage = json.loads(next(item for item in ok(service, 'dataset.list') if item['id'] == saved['dataset_id'])['derivation_json'])
    assert len(lineage['phone_outcomes']) == 2


def test_recording_evidence_makes_a_reviewed_scan_stale(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Freshness', [FILE_A[0]])
    config = confirmed(service, dataset)
    report = scan(service, dataset, config)
    record(service, '+17135553142', 'voicemail', dataset)
    assert ok(service, 'skiptrace.freshness', dataset_id=dataset)['fingerprint'] != report['fingerprint']
    job = wait(service, ok(service, 'skiptrace.apply', dataset_id=dataset, config=config, scan_job_id=report['scan_job_id'])['job_id'])
    assert job['state'] == 'failed' and 'out of date' in job['error']


def test_new_reached_call_conflicts_with_old_wrong_evidence_but_cannot_override_dnc(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Old wrong', [FILE_A[0]])
    config = confirmed(service, dataset)
    ok(service, 'marks.set', number='+17135553142', mark='wrong_number')
    record(service, '+17135553142', 'reached', dataset)
    report = scan(service, dataset, config)
    choice = next(item for item in choices(report) if item['number'] == '+17135553142')
    assert choice['quality'] == 'suspicious' and not choice['blocked']
    assert report['preview'][0]['raw']['Phone (verdict)'] == 'wrong'
    ok(service, 'marks.set', number='+17135553142', mark='do_not_call')
    choice = next(item for item in choices(scan(service, dataset, config)) if item['number'] == '+17135553142')
    assert choice['permission'] == 'blocked_dnc' and choice['blocked']


def test_imported_call_dates_drive_age_and_undated_calls_are_unknown(service, tmp_path):
    path = tmp_path / 'dates.csv'
    path.write_text('Name,Phone,Status,Call Date\nAna,7135553142,Interested,2020-01-01\nBo,7135554455,Interested,not a date\n', encoding='utf-8')
    dataset = run(service, 'dataset.import', path=str(path))['dataset_id']
    config = confirmed(service, dataset)
    config.update(call_date_column='Call Date', evidence_age_days=60)
    config['outcome'] = {'column': 'Status', 'called_column': 'Phone', 'map': {'interested': ['reached']}}
    report = scan(service, dataset, config)
    assert any('60 days old' in text for text in choices(report)[0]['warnings'])
    assert any('age is unknown' in text for text in choices(report, 1)[0]['warnings'])


@pytest.mark.parametrize('kind,extra', [('possible_household', 'address'), ('possible_business', 'company'), ('unrelated_people', None)])
def test_shared_numbers_explain_household_business_and_unrelated_people(service, tmp_path, kind, extra):
    path = tmp_path / 'sharing.csv'
    path.write_text('Name,Phone,Street,Company\nAna Lopez,7135553142,123 Main,Acme\nBo Reyes,7135553142,123 Main,Acme\n', encoding='utf-8')
    dataset = run(service, 'dataset.import', path=str(path))['dataset_id']
    config = ok(service, 'skiptrace.suggest', dataset_id=dataset)['config']
    config['name_column'] = 'Name'
    if extra == 'address': config['address_column'] = 'Street'
    if extra == 'company': config['business_column'] = 'Company'
    report = scan(service, dataset, config)
    choice = choices(report)[0]
    assert choice['shared']['kind'] == kind and choice['shared']['people'] == 2
    assert report['preview'][0]['raw']['Phone (verdict)'] == 'suspicious'
    assert choice['quality'] == ('suspicious' if kind == 'unrelated_people' else 'unverified')


def test_invalid_outcomes_scope_and_future_dates_are_refused(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Validation', [FILE_A[0]])
    confirmed(service, dataset)
    for payload in [dict(number='7135553142', outcome='reached'), dict(number='+17135553142', outcome='unknown'), dict(number='+17135553142', outcome='wrong_person'), dict(number='+17135554455', outcome='reached', dataset_id=dataset, row_number=999), dict(number='+17135556677', outcome='reached', dataset_id=dataset, row_number=2), dict(number='+17135553142', outcome='reached', occurred_at='2999-01-01')]:
        assert not call(service, 'phone.record_outcome', **payload)['ok']
    assert ok(service, 'phone.outcomes') == []


def test_evidence_is_project_scoped_and_survives_reopen(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Persistent', [FILE_A[0]])
    confirmed(service, dataset)
    record(service, '+17135553142', 'no_answer', dataset)
    root = service.project['root_path']
    ok(service, 'project.create', path=str(tmp_path / 'other'), name='Other')
    assert ok(service, 'phone.outcomes') == []
    ok(service, 'project.open', path=root)
    assert len(ok(service, 'phone.outcomes')) == 1


def test_lookup_is_disabled_by_default_and_never_requests_implicitly(service, tmp_path, monkeypatch):
    monkeypatch.setattr(phone_lookup, 'fetch_number', lambda *args: pytest.fail('No implicit network calls'))
    dataset = make_dataset(service, tmp_path, 'Offline', [FILE_A[0]])
    config = confirmed(service, dataset)
    assert not ok(service, 'phone.lookup_settings')['enabled']
    assert scan(service, dataset, config)['rows'] == 1
    assert not call(service, 'phone.lookup_preview', dataset_id=dataset, config=config)['ok']


def test_lookup_deduplicates_prices_caps_caches_and_keeps_secrets_out_of_project(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, 'Lookup', [FILE_A[0], FILE_A[0]])
    config = confirmed(service, dataset)
    public = provider(service)
    assert public['configured'] and 'auth_token' not in public and 'account_sid' not in public
    calls = []
    def fake(number, saved):
        calls.append(number)
        return {'carrier': 'Test carrier', 'type': 'mobile', 'line_status': 'unknown', 'ownership_verified': False}
    monkeypatch.setattr(phone_lookup, 'fetch_number', fake)
    before = ok(service, 'skiptrace.freshness', dataset_id=dataset)['fingerprint']
    preview, result = lookup(service, dataset, config, max_numbers=1)
    assert preview['unique_numbers'] == 2 and preview['requests'] == 1 and preview['remaining'] == 1
    assert preview['estimated_cost'] == '0.008'
    assert result['succeeded'] == 1 and len(calls) == 1
    assert ok(service, 'skiptrace.freshness', dataset_id=dataset)['fingerprint'] != before
    preview, _ = lookup(service, dataset, config)
    assert preview['cached'] == 1 and preview['requests'] == 1
    reused = ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)
    assert reused['cached'] == 2 and reused['requests'] == 0
    history = ok(service, 'phone.lookup_history')
    assert len(history) == 2
    report = scan(service, dataset, config)
    assert choices(report)[0]['lookup']['carrier'] == 'Test carrier'
    assert not choices(report)[0]['lookup']['ownership_verified']
    dump = '\n'.join(service.store._connection.iterdump())
    assert 'b' * 32 not in dump and 'AC' + 'a' * 32 not in dump
    assert phone_lookup._file().parent != service.store.project_root
    if os.name != 'nt':  # Windows has no Unix permission bits; the file still lives outside the project
        assert phone_lookup._file().stat().st_mode & 0o777 == 0o600
    ok(service, 'phone.configure_lookup', clear_credentials=True, enabled=False)
    assert not ok(service, 'phone.lookup_settings')['configured']
    assert len(ok(service, 'phone.lookup_history')) == 2


def test_changed_price_invalidates_quote_and_unknown_price_is_explicit(service, tmp_path):
    dataset = make_dataset(service, tmp_path, 'Quote', [FILE_A[0]])
    config = confirmed(service, dataset)
    provider(service)
    preview = ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)
    ok(service, 'phone.configure_lookup', unit_cost=None)
    refused = call(service, 'phone.lookup', dataset_id=dataset, config=config, quote_token=preview['quote_token'])
    assert not refused['ok'] and 'Preview' in refused['error']['message']
    assert ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)['estimated_cost'] is None


def test_provider_failure_is_retained_but_never_used_as_evidence(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, 'Failure', [FILE_A[0]])
    config = confirmed(service, dataset)
    provider(service)
    def fail(*args): raise ValueError('Provider did not return a usable response')
    monkeypatch.setattr(phone_lookup, 'fetch_number', fail)
    _, result = lookup(service, dataset, config)
    assert result['failed'] == 2 and result['succeeded'] == 0
    assert all(not row['success'] and row['error'] for row in ok(service, 'phone.lookup_history'))
    assert all(choice['lookup'] is None for choice in choices(scan(service, dataset, config)))
    assert ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)['cached'] == 0


def test_auth_failure_stops_batch_and_retains_failed_attempt(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, 'Auth', [FILE_A[0]])
    config = confirmed(service, dataset)
    provider(service)
    def fail(*args): raise ValueError('Provider returned HTTP 401; check credentials')
    monkeypatch.setattr(phone_lookup, 'fetch_number', fail)
    preview = ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)
    job = wait(service, ok(service, 'phone.lookup', dataset_id=dataset, config=config, quote_token=preview['quote_token'])['job_id'])
    assert job['state'] == 'failed' and 'Remaining requests stopped' in job['error']
    assert len(ok(service, 'phone.lookup_history')) == 1


def test_cancellation_retains_completed_request_and_blocks_parallel_paid_batches(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, 'Cancel lookup', [FILE_A[0]])
    config = confirmed(service, dataset)
    provider(service)
    entered, release = Event(), Event()
    def fake(*args):
        entered.set()
        assert release.wait(5)
        return {'carrier': 'Test', 'type': 'mobile', 'line_status': 'unknown', 'ownership_verified': False}
    monkeypatch.setattr(phone_lookup, 'fetch_number', fake)
    preview = ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)
    job_id = ok(service, 'phone.lookup', dataset_id=dataset, config=config, quote_token=preview['quote_token'])['job_id']
    assert entered.wait(5)
    try:
        assert not call(service, 'phone.lookup', dataset_id=dataset, config=config, quote_token=preview['quote_token'])['ok']
        ok(service, 'job.cancel', job_id=job_id)
    finally:
        release.set()
    assert wait(service, job_id)['state'] == 'cancelled'
    assert len(ok(service, 'phone.lookup_history')) == 1


def test_fresh_inactive_lookup_blocks_choice_but_stale_lookup_only_prompts_review(service, tmp_path, monkeypatch):
    dataset = make_dataset(service, tmp_path, 'Inactive', [FILE_A[0]])
    config = confirmed(service, dataset)
    provider(service, products=['line_type_intelligence', 'line_status'])
    monkeypatch.setattr(phone_lookup, 'fetch_number', lambda *args: {'carrier': 'Test', 'type': 'mobile', 'line_status': 'inactive', 'ownership_verified': False})
    lookup(service, dataset, config)
    report = scan(service, dataset, config)
    assert report['rows_with_callable_number'] == 0
    assert all(choice['blocked'] and choice['quality'] == 'unverified' for choice in choices(report))
    old = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    with service.store._connection:
        service.store._connection.execute('UPDATE phone_lookups SET checked_at=?', (old,))
    report = scan(service, dataset, config)
    assert report['rows_with_callable_number'] == 1
    assert all(not choice['blocked'] and choice['lookup']['stale'] for choice in choices(report))
    assert ok(service, 'phone.lookup_preview', dataset_id=dataset, config=config)['cached'] == 0


def test_twilio_adapter_uses_selected_products_and_rejects_bad_or_mismatched_responses(monkeypatch):
    import io
    saved = {'account_sid': 'AC' + 'a' * 32, 'auth_token': 'b' * 32, 'products': ['line_type_intelligence', 'line_status']}
    requests = []
    response = {'phone_number': '+17135553142', 'valid': True, 'country_code': 'US', 'line_type_intelligence': {'carrier_name': 'Carrier', 'type': 'mobile', 'error_code': None}, 'line_status': {'status': 'active', 'error_code': None}}
    def fake(request, timeout):
        requests.append(request)
        assert timeout == 15
        return io.BytesIO(json.dumps(response).encode())
    monkeypatch.setattr(phone_lookup, 'urlopen', fake)
    result = phone_lookup.fetch_number('+17135553142', saved)
    assert result['carrier'] == 'Carrier' and result['line_status'] == 'active' and result['ownership_verified'] is False
    assert 'Fields=line_type_intelligence%2Cline_status' in requests[0].full_url
    assert requests[0].get_header('Authorization').startswith('Basic ')
    response['line_status'] = {'Status': 'Inactive', 'ErrorCode': None}
    assert phone_lookup.fetch_number('+17135553142', saved)['line_status'] == 'inactive'
    response['line_status'] = {'status': 'active', 'error_code': None}
    response['line_status']['error_code'] = 60601
    with pytest.raises(ValueError, match='product access'): phone_lookup.fetch_number('+17135553142', saved)
    response['phone_number'] = '+17135554455'
    with pytest.raises(ValueError, match='different'): phone_lookup.fetch_number('+17135553142', saved)
