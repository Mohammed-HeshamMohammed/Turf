# Billing service

Plans, subscriptions, payments, call minutes and desktop credits. Plan: [docs/plans/billing-service.md](../../docs/plans/billing-service.md).
Money never moves through Caller Whale's servers: the payment provider takes it, and this service records what the provider's
signed webhooks say.

| | |
| --- | --- |
| Language | Python 3.13 (FastAPI). Chosen for exact money in the standard library and official Paddle and Stripe libraries |
| Port | 8103 |
| Owns data | Yes: its own PostgreSQL database and login, tables in the `billing` schema (`database_setup/`) |
| Public address | None of its own. The gateway sends `/api/v1/plans` and `/api/v1/billing/webhook` here (path routes, still to build in the gateway) |
| Status | First version. Not yet used by the core API (shadow mode is the next step) |

## Coolify

| Setting | Value |
| --- | --- |
| Source | branch `billing-backend-production` |
| Build pack | Dockerfile |
| Base directory | `/` |
| Dockerfile location | `/Dockerfile` |
| Port | 8103 |
| Network alias | `billing` |
| Domain | none |
| Settings | every key in `env/billing.production.example`, in Coolify only |

## What it answers

| Request | Who | Answer |
| --- | --- | --- |
| `GET /api/v1/plans` | anyone (through the gateway) | The plans on sale, prices as exact decimals |
| `POST /api/v1/billing/webhook` | Paddle (through the gateway) | Checks `Paddle-Signature`, stores the event once by its id, applies subscription and payment events; a redelivery changes nothing |
| `POST /v1/reservations` | core API | Takes call minutes (account = workspace) or desktop credits (account = person) from this period's allowance, once per `request_id`; `402 limit_reached` or `402 payment_required` when it cannot |
| `GET /v1/orgs/{org}/standing` | core API, worker, auth | Plan, status, period, seats, minutes used, whether the plan needs paying, and whether it is paid through the provider and by whom (`provider_paid`, `payer_id`, from the checkout's `custom_data.payer_id`; a handover of ownership waits for the new owner to pay) |
| `PUT /v1/orgs/{org}/trial` | core API | Opens a trial for a new workspace (once) |
| `POST /v1/usage` | dialer-sms | Checks (`check_only`) or charges call minutes or a text to the lead's team, the person and the client, once per `request_id`, within their monthly budgets (and, for minutes, the plan's allowance); `402 budget_reached` when one is used up (step 22) |
| `GET`/`PUT /v1/orgs/{org}/budgets`, `POST /v1/orgs/{org}/raise-requests` | dialer-sms | Budgets per team, person or client with this month's use, and requests to raise them, which raising answers. Who may set which is checked by the dialer |
| `PUT /v1/people/{user}/credit-limit` | core API | A person's monthly desktop credits, or no limit |
| `GET /healthz`, `GET /version` | anyone | Health and version |

Private requests need `Authorization: Bearer <token>` from `BILLING_TOKENS`. When a workspace's standing changes, billing tells
the authorization service (`AUTHZ_URL`, `AUTHZ_TOKEN`), so every grant there follows the plan.

## Money rules

- Amounts are `Decimal` in code and whole minor units (cents) with an ISO 4217 code in the database. Never `float`.
- One rounding rule: half-even.
- The ledger is append-only (a database trigger refuses edits and deletes); a correction is its own row.
- A reservation locks the allowance row until the use is written, so two requests cannot both take the last unit.

## Run and test

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -r requirements-test.txt     # on Linux/macOS: .venv/bin/python
.venv/Scripts/python -m unittest discover -s tests
```

The database tests (`tests/test_store_db.py`) run against a real, empty PostgreSQL database: set `TEST_DATABASE_URL`.

`openapi.yaml` is generated from the code, and a test fails when it is out of date. Regenerate it with:

```bash
.venv/Scripts/python -c "import json; from callerwhale_billing import config; from callerwhale_billing.app import create_app; open('openapi.yaml','w').write('# Generated from the code (see README). JSON is valid YAML.\n' + json.dumps(create_app(config.Settings(database_url='x'), None).openapi(), indent=2) + '\n')"
```
