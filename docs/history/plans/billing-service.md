# Billing service: its own container and its own language

**Now (2026-11-22):** built as `services/billing` and deployed; parked (it restarts until the short `core-api=` token leaves `BILLING_TOKENS`). Below is the plan.

Status: plan, nothing built. The owner decided on 2026-11-04 that billing leaves the core API and is not part of authorization: it gets its own container and its own language. The language was left to research (below).

## Language: Python

**Choice: Python (3.13 or newer)**, replacing the TypeScript scaffold in `services/billing`.

What decided it, in order:

1. **Exact money in the standard library.** Python's `decimal` module is exact base-10 arithmetic with chosen rounding modes, built in. Java (`BigDecimal`) and C# (`decimal`) also have it built in; Go and JavaScript/TypeScript do not and need a third-party library or integer cents.
2. **Official libraries for our payment providers.** The payment plan (`payment-methods-by-region.md`) starts with **Paddle** everywhere, adds **Stripe** (ACH, pre-authorized debit) and later **Paystack or Flutterwave** for Africa. Paddle's official server libraries are Node.js, Python, Go and PHP only; Stripe's are Ruby, PHP, Java, Python, Node, .NET and Go. The languages with official libraries for **both** are Python, Node, Go and PHP.
3. **Its own language,** as the owner asked: not Go (the edge services and authorization), not Rust (the core API today).

Putting the three together: Python is the only language that has exact decimals built in **and** official Paddle and Stripe libraries. Java and C# lose on Paddle (no official library); Node and Go lose on exact decimals; PHP was not considered for a service here.

What it costs: Python is slower than Go or Rust. Billing is low-traffic (checkouts, webhooks, a few checks per call or credit use), so the time goes to the database and the payment provider, not the language. The one frequent request, reserving minutes or credits, is a single database transaction; measure it (step 3 below). Python is already used for Skip Tracing, so it is not a new toolchain for the team.

Alternatives, for the record:

| Language | Exact decimals | Paddle official | Stripe official | Notes |
| --- | --- | --- | --- | --- |
| **Python** | built in (`decimal`) | yes | yes | chosen |
| Java | built in (`BigDecimal`) | no | yes | Kill Bill, a full open-source billing platform, is Java (Apache-2.0) |
| C# | built in (`decimal`, 28-29 digits) | no | yes (.NET) | |
| Go | library (`shopspring/decimal`) | yes | yes | not "its own language" |
| TypeScript | library | yes | yes | today's scaffold |

## What billing does, read from the core API today

`routes/billing.rs` and the access tables: the trial workspace, plans, checkout (records a pending payment and hands the browser to the provider), the provider's signed webhook (the only thing that marks a payment paid and changes a plan), the call-minute ledger with seats and minutes enforced (subscription row locked so two calls cannot take the last minute), seat checks on invitations and joining, monthly desktop credits (`access_invitations`, `credit_usage`), and the staff payments page. **Money never moves through our servers:** the provider takes the payment; we record what it tells us.

## What moves into the billing service

| Today in the core API | In billing |
| --- | --- |
| `/plans`, `/billing`, `/billing/checkout`, `/billing/webhook` | Same paths, served by billing |
| `/calls/start`, `/calls/{id}/end` (minutes) and `/credits/use` (credits) | Reservation and usage requests on billing; the core API calls them |
| Tables `subscriptions`, payments, the minutes ledger, `credit_usage`, monthly credit limits | Billing's own database |
| Seat checks on invitations and joining | A billing check the core API calls before an invitation |
| `/platform/payments` (staff) | Billing |
| Trial workspace creation | The core API still creates the workspace; billing opens its trial subscription |
| "Payment required" and suspension standing | Billing owns it and publishes it; authorization includes it in every grant, so the database rights follow the plan |

## How it is built

| Part | Choice |
| --- | --- |
| Web framework | FastAPI with Pydantic v2 (typed requests and answers, OpenAPI file generated and kept in `openapi.yaml`) |
| Database | Its own PostgreSQL database and login, `callerwhale_billing`; `psycopg` 3 |
| Database setup | Numbered SQL scripts with checksums and a lock, the same rules as the other services |
| Money | `Decimal` in code, never `float`; amounts stored as integer minor units (cents) plus an ISO 4217 currency code; one written rounding rule (half-even) used everywhere |
| Ledgers | Append-only: a usage or payment is a new row, never an edit; balances are sums, and corrections are their own rows |
| Reservations | Minutes and credits are reserved in one transaction with the subscription row locked, keyed by a request id so a retry never charges twice |
| Webhooks | Signature checked with the provider's library; stored by the provider's event id and applied once; answered quickly and processed from the stored copy |
| Providers | Paddle first (official Python SDK), Stripe second (official Python SDK), Paystack or Flutterwave later; one small adapter per provider behind one interface |
| Tax and invoices | Paddle is the merchant of record and handles tax and invoices for its sales; for Stripe sales, tax is decided with the accountant before launch (see the payment plan's checklist) |
| Who may do what | Asks authorization for a grant on every signed-in request (the `finance` capability for money pages), like the core API |
| Events out | Plan and standing changes published on the Redis event bus, read by authorization and the core API |
| Mail | Receipts and payment problems go through the notification service via the gateway |
| Logs | The shared `callerwhale-log` runner |
| Tests | `pytest` against a real PostgreSQL; provider webhooks replayed from recorded samples; a property test that ledger sums never go negative |

## Container and routing

| Item | Value |
| --- | --- |
| Folder | `services/billing` (scaffold replaced) |
| Port | 8103 (as in the scaffold) |
| Coolify app | `billing`, network alias `billing` |
| Branch | `billing-backend-production`, service at the branch root (Base directory `/`, Dockerfile `/Dockerfile`) |
| Public access | **No domain of its own.** The gateway sends `gate.callerwhale.com/api/v1/billing...`, `/api/v1/plans` and the webhook path to billing, so the apps and the provider's webhook URL do not change. This needs path-prefix routes in the gateway (it routes by host only today) |
| Private access | The core API calls billing's reservation and seat checks on the private network with its own machine token |

## Order of work

0. **Inventory** every table, query and route in the core API that touches plans, subscriptions, payments, minutes, seats or credits.
1. **Build the service** in Python: database, ledgers, reservations, webhooks for Paddle, the routes above, tests.
2. **Gateway path routes** so billing paths go to billing.
3. **Copy the data** and **measure** a reservation's time.
4. **Shadow mode:** the core API stays in charge; billing receives a copy of every webhook and computes standing, minutes and credits; disagreements are logged.
5. **Switch** webhooks and the billing pages to billing; then reservations and seat checks.
6. **Remove** billing code and tables from the core API.

Each step is its own commit, can be undone with a setting, and comes with its Coolify steps.

## Questions for the owner

1. Paddle first, as the payment plan says? (Paddle accepting the company as a seller is still unchecked in that plan.)
2. Should desktop credits (staff-set monthly limits) and call minutes be one ledger with two kinds, or stay two ledgers?

## Sources

- [Paddle: Go SDK stable release (lists the official SDKs)](https://developer.paddle.com/changelog/2024/go-sdk-stable-release)
- [Paddle: Python SDK](https://developer.paddle.com/changelog/2024/python-sdk/)
- [Paddle: PHP and Node.js SDKs stable release](https://developer.paddle.com/changelog/2024/php-nodejs-sdks-stable-release/)
- [Stripe: server-side SDKs](https://docs.stripe.com/sdks/server-side?locale=en-GB)
- [Handling currency values: facts and best practices (DEV)](https://dev.to/cardinalby/handling-currency-values-facts-and-best-practices-3l81)
- [Java BigDecimal (MojoAuth)](https://mojoauth.com/dev-guides/decimal-with-java)
- [C# decimal type (MojoAuth)](https://mojoauth.com/dev-guides/decimal-with-c.md)
- [Go: exact decimal math (MojoAuth)](https://mojoauth.com/dev-guides/decimal-with-go.md)
- [shopspring/decimal gotchas](https://tessl.io/registry/tessl/golang-github-com-shopspring--decimal/files/docs/guides/gotchas-and-best-practices.md)
- [Kill Bill: open-source subscription billing (Java)](https://www.blog.brightcoding.dev/2026/08/06/killbillkillbill-open-source-subscription-billing-for-saas)
- [Lago API (Ruby)](https://awesome.ecosyste.ms/projects/github.com%2Fgetlago%2Flago-api)
