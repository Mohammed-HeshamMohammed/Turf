"""Optional Twilio Lookup v2 integration. Credentials stay outside portable projects."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from urllib.error import HTTPError, URLError
from urllib.parse import quote as urlquote, urlencode
from urllib.request import Request, urlopen

from turf_matching import skiptrace as engine
from .jobs import JobKind, JobValidationError
from .projects import app_data_dir
from .storage import utc_now

PROVIDER = 'Twilio Lookup v2'


def _file():
    return app_data_dir() / 'phone-lookup-settings.json'


def _settings():
    try:
        return json.loads(_file().read_text('utf-8'))
    except FileNotFoundError:
        return {'enabled': False, 'products': ['line_type_intelligence'], 'cache_days': 30, 'unit_cost': None, 'revision': ''}


def settings():
    saved = _settings()
    return {key: saved.get(key) for key in ('enabled', 'products', 'cache_days', 'unit_cost', 'revision')} | {'provider': PROVIDER, 'configured': bool(saved.get('account_sid') and saved.get('auth_token')), 'currency': 'USD'}


def configure(payload):
    import re
    saved = _settings()
    if payload.get('clear_credentials'):
        saved.pop('account_sid', None)
        saved.pop('auth_token', None)
    sid = str(payload.get('account_sid') or '').strip()
    token = str(payload.get('auth_token') or '').strip()
    if sid or token:
        if not re.fullmatch(r'AC[0-9a-fA-F]{32}', sid) or not re.fullmatch(r'[0-9a-fA-F]{32}', token):
            raise ValueError('Enter a Twilio Account SID (AC plus 32 hex characters) and Auth Token (32 hex characters)')
        saved.update(account_sid=sid, auth_token=token)
    products = payload.get('products', saved['products'])
    if not isinstance(products, list) or not products or set(products) - {'line_type_intelligence', 'line_status'}:
        raise ValueError('Choose line type intelligence and/or line status')
    unit_cost = payload.get('unit_cost', saved.get('unit_cost'))
    if unit_cost in ('', None):
        unit_cost = None
    else:
        try:
            cost = Decimal(str(unit_cost))
        except InvalidOperation:
            raise ValueError('Enter a valid total USD cost per number') from None
        if not cost.is_finite() or cost < 0 or cost > 100:
            raise ValueError('Cost per number must be between 0 and 100 USD')
        unit_cost = str(cost)
    days = int(payload.get('cache_days', saved['cache_days']))
    if not 1 <= days <= 365:
        raise ValueError('Cache age must be between 1 and 365 days')
    enabled = bool(payload.get('enabled', saved['enabled']))
    if enabled and not (saved.get('account_sid') and saved.get('auth_token')):
        raise ValueError('Add provider credentials before enabling lookup')
    saved.update(enabled=enabled, products=sorted(set(products)), unit_cost=unit_cost, cache_days=days, revision=str(uuid.uuid4()))
    path = _file()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as file:
            temporary = file.name
            os.chmod(temporary, 0o600)
            json.dump(saved, file)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return settings()


def latest(store):
    result = {}
    for row in store._connection.execute('SELECT * FROM phone_lookups WHERE success=1 ORDER BY checked_at, id'):
        result[row['number']] = {'id': row['id'], 'provider': row['provider'], 'products': json.loads(row['products']), 'checked_at': row['checked_at'], **json.loads(row['result_json'])}
    return result


def history(store, number=None, offset=0):
    return [{**dict(row), 'result': json.loads(row['result_json']), 'products': json.loads(row['products'])} for row in store._connection.execute(
        'SELECT * FROM phone_lookups WHERE (? IS NULL OR number=?) ORDER BY checked_at DESC LIMIT 100 OFFSET ?', (number, number, max(0, int(offset))))]


def _selection(store, payload, saved):
    from .skiptrace import _dataset, clean_config, get_settings
    from .cleaning import _rows
    dataset = _dataset(store, payload['dataset_id'])
    _, rows = _rows(store, dataset['id'])
    config = clean_config(payload.get('config') or get_settings(store, dataset['id']), list(dict.fromkeys(key for row in rows for key in row)))
    numbers = set()
    for row in rows:
        country, source = engine._row_country(row, config)
        for column in config['phone_columns']:
            numbers.update(info.e164 for info in engine.read_cell(row.get(column), config['region'], country, source) if info.valid and info.e164)
    # Only successful lookups of exactly the selected products qualify for reuse.
    cutoff = (datetime.now(timezone.utc) - timedelta(days=saved['cache_days'])).isoformat()
    cached = {row['number'] for row in store._connection.execute('SELECT number, products FROM phone_lookups WHERE success=1 AND checked_at>=?', (cutoff,)) if set(json.loads(row['products'])) == set(saved['products'])}
    maximum = int(payload.get('max_numbers', 100))
    if not 1 <= maximum <= 5000:
        raise ValueError('Choose between 1 and 5,000 numbers per lookup batch')
    pending = sorted(numbers - cached)
    selected = pending[:maximum]
    token = hashlib.sha256(json.dumps({'dataset': dataset['id'], 'config': config, 'numbers': selected, 'revision': saved['revision'], 'cached': sorted(numbers & cached)}, sort_keys=True).encode()).hexdigest()
    estimate = str(Decimal(saved['unit_cost']) * len(selected)) if saved['unit_cost'] is not None else None
    return {'provider': PROVIDER, 'unique_numbers': len(numbers), 'cached': len(numbers & cached), 'requests': len(selected), 'remaining': max(0, len(pending) - maximum), 'estimated_cost': estimate, 'unit_cost': saved['unit_cost'], 'currency': 'USD', 'products': saved['products'], 'quote_token': token, 'numbers': selected, 'config': config, 'max_numbers': maximum}


def preview(store, payload):
    saved = _settings()
    if not saved['enabled'] or not saved.get('account_sid') or not saved.get('auth_token'):
        raise ValueError('Configure and enable the optional provider first')
    selected = _selection(store, payload, saved)
    return {key: value for key, value in selected.items() if key not in ('numbers', 'config')}


def _validate(store, payload):
    if store._connection.execute("SELECT 1 FROM jobs WHERE kind='phone_lookup' AND state IN ('queued','running','paused') LIMIT 1").fetchone():
        raise JobValidationError('A phone lookup is already running in this project. Reconnect to it or wait before starting another batch.')
    saved = _settings()
    if not saved['enabled'] or not saved.get('auth_token'):
        raise JobValidationError('Configure and enable the optional provider first')
    selection = _selection(store, payload, saved)
    if payload.get('quote_token') != selection['quote_token']:
        raise JobValidationError('Lookup settings or cached results changed. Preview the cost again before running.')
    if not selection['numbers']:
        raise JobValidationError('No new requests are needed; successful cached results are already available')
    # Never store secrets in job params, events, or the project database.
    return {'dataset_id': payload['dataset_id'], 'numbers': selection['numbers'], 'products': saved['products'], 'revision': saved['revision'], 'unit_cost': saved['unit_cost']}


def fetch_number(number, saved):
    query = urlencode({'Fields': ','.join(saved['products'])})
    credential = base64.b64encode(f"{saved['account_sid']}:{saved['auth_token']}".encode()).decode()
    request = Request(f'https://lookups.twilio.com/v2/PhoneNumbers/{urlquote(number, safe="")}?{query}', headers={'Authorization': f'Basic {credential}', 'Accept': 'application/json'})
    try:
        with urlopen(request, timeout=15) as response:
            data = json.load(response)
    except HTTPError as error:
        # Provider bodies may contain account details: keep errors useful without retaining the body.
        raise ValueError(f'Provider returned HTTP {error.code}; check credentials, product access, balance, or rate limits') from None
    except (URLError, TimeoutError, OSError, json.JSONDecodeError):
        raise ValueError('Provider did not return a usable response; check connectivity and try again') from None
    if not isinstance(data, dict):
        raise ValueError('Provider did not return a usable response')
    if data.get('phone_number') != number:
        raise ValueError('Provider returned a different phone number; result was not used')
    for product in saved['products']:
        detail = data.get(product)
        if not isinstance(detail, dict) or detail.get('error_code') or detail.get('ErrorCode'):
            raise ValueError(f'Provider could not supply {product.replace("_", " ")}; verify product access and coverage')
    line = data.get('line_type_intelligence') or {}
    status = data.get('line_status') or {}
    line = line if isinstance(line, dict) else {}
    status = status if isinstance(status, dict) else {}
    line_status = str(status.get('status') or status.get('Status') or 'unknown').strip().lower()
    if line_status not in ('active', 'inactive', 'reachable', 'unreachable', 'unknown'):
        line_status = 'unknown'
    return {'carrier': line.get('carrier_name'), 'type': line.get('type'), 'line_status': line_status,
            'valid_format': data.get('valid'), 'country_code': data.get('country_code'), 'ownership_verified': False}


def _run(context):
    saved = _settings()
    if not saved['enabled'] or saved['revision'] != context.params['revision']:
        raise ValueError('Provider settings changed; preview and run lookup again')
    counts = {'requested': len(context.params['numbers']), 'succeeded': 0, 'failed': 0}
    for index, number in enumerate(context.params['numbers']):
        context.checkpoint()
        current = _settings()
        if not current['enabled'] or current['revision'] != saved['revision']:
            raise ValueError('Provider settings changed. Completed results are retained; remaining requests stopped.')
        context.stage('looking_up_phones', {'done': index, 'total': counts['requested']})
        result, error = {}, None
        try:
            result = fetch_number(number, saved)
        except ValueError as failure:
            error = str(failure)
        # Keep completed requests even if cancellation arrives during the network call.
        with context.store._connection:
            context.store._connection.execute('INSERT INTO phone_lookups(id,number,provider,products,checked_at,success,result_json,estimated_cost,error) VALUES (?,?,?,?,?,?,?,?,?)',
                (str(uuid.uuid4()), number, PROVIDER, json.dumps(saved['products']), utc_now(), not error, json.dumps(result), saved['unit_cost'], error))
        counts['failed' if error else 'succeeded'] += 1
        if error and ('HTTP 401' in error or 'HTTP 403' in error or 'HTTP 429' in error):
            raise ValueError(f'{error}. Remaining requests stopped; completed results are retained.')
    context.stage('looking_up_phones', {'done': counts['requested'], 'total': counts['requested']})
    return counts


LOOKUP_JOB = JobKind(run=_run, validate=_validate)
