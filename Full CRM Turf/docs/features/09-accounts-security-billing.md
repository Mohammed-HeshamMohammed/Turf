# Feature 9: Accounts, security and billing

**Status:** Written for review (2026-10-25)

Customers don't buy this as a feature, but every plan depends on it and it carries the biggest per-customer cost after calling: **payment fees**.

## What exists today

From [the SaaS notes](../saas/README.md):

- **Sign-up website** (`/#/signup`): name, email, password (12+ characters), optional business name. Creates the person, the organization, the role presets, the owner membership and a trial.
- **Email confirmation**, required before buying a plan.
- **Google sign-in** on the website and in the app (desktop sign-in happens in the person's own browser). Apple sign-in is built but off until there is a paid Apple Developer account and an HTTPS domain.
- **Two-step sign-in (MFA)** for owners and administrators: an authenticator code plus ten recovery codes. It is currently switched off while sign-in is being finished.
- **Lockout:** five failed sign-ins in 15 minutes pauses that account.
- **Passwords** stored only as Argon2id hashes; sessions in HttpOnly cookies.
- **Row security** in PostgreSQL, so one organization can never read another's rows.
- **Platform administrators** (Turf's own staff, with MFA) see every customer organization.
- **Plans, seats and minutes** live in the `plans` table; the server enforces every limit.
- **Checkout** sends the browser to the payment provider; **only the provider's signed webhook** marks a payment paid. No card numbers are stored by Turf.

**Not chosen or not built yet:** the payment provider itself, invoices and receipts, sales tax, failed-payment retries, plan changes mid-month, cancellation and the 30-day data window (Feature 8), single sign-on (SSO), an audit-log screen, and a "signed-in devices" screen.

## What the customer gets

| Part | What it does |
| --- | --- |
| **Sign-up and sign-in** | Email and password, or Google; Apple later |
| **Two-step sign-in** | Authenticator app + recovery codes; required for owners and administrators, optional for everyone else |
| **Signed-in devices** | See and sign out every device and browser |
| **Single sign-on (SSO)** | Sign in through the company's Google Workspace or Microsoft 365 (SAML / OIDC), for larger teams |
| **Audit log** | Who did what and when: sign-ins, exports, permission changes, deletions, restores |
| **Billing page** | Plan, seats, minutes used, add-ons, invoices and receipts, change plan, cancel |
| **Seats** | Add or remove seats any time; changes are prorated |
| **Failed payments** | Automatic retries and reminder emails before anything is paused; data is never deleted for a late payment |

## Where it runs

Everything runs on the server. The desktop and web apps show the screens; sign-in on the desktop goes through the person's own browser (as built today); phones use the web sign-in.

## Where the data lives

| Data | Where |
| --- | --- |
| Accounts, password hashes, MFA secrets, recovery codes | Server only (as built) |
| Sessions | Server; an HttpOnly cookie on the device |
| **Card numbers and bank details** | **Only at the payment provider**, never at Turf |
| Payments, invoices, plan, seats | Server, with the provider's reference |
| Audit log | Server, per workspace; kept 1 year (Pro: 2 years) |

## Payment provider: the main decision

| | **Stripe** | **Paddle** (merchant of record) |
| --- | --- | --- |
| Card fee | 2.9% + $0.30 (US cards) | **5% + $0.50, all-in** |
| Subscriptions (Stripe Billing) | +0.7% of billing volume | Included |
| Sales tax calculation (Stripe Tax) | +0.5% | Included |
| **Who owes the sales tax** | **Turf** registers and files in every state where it owes tax on software | **Paddle** is the seller of record and handles US sales tax and foreign VAT |
| Effective rate | ~**4.1% + $0.30** | **5% + $0.50** |
| Disputes | $15 each | Handled by Paddle |

Many US states tax software subscriptions, and each has its own registration and filing. A merchant of record takes that off Turf's hands for about 1% more.

**Recommendation:** start with **Paddle** (or Lemon Squeezy, also 5% + $0.50) while Turf is small, so nobody at Turf has to deal with sales-tax filing. Move to Stripe once revenue justifies an accountant handling sales tax. The server already accepts any provider through the signed webhook, so switching is contained.

**Annual billing** cuts the fixed $0.30–0.50 per payment to once a year and is worth offering at a discount.

## What it costs Turf

| Item | Cost |
| --- | --- |
| **Payment fees** | **~5% + $0.50 per payment** with Paddle (~4.1% + $0.30 with Stripe) |
| Sign-up, verification and billing emails | Amazon SES, ~$0.10–0.16 per 1,000: ~$0 |
| Google sign-in, authenticator MFA | $0 |
| SSO | $0 if built in the Rust API (no per-connection service fee) |
| Audit log storage | Database rows: ~$0 |
| Apple sign-in (later) | Apple Developer account, $99 a year, for all customers together |

Payment fees on the running plan totals:

| | Solo | Duo | Team | Pro |
| --- | --- | --- | --- | --- |
| Running total (Features 1–6) | $344 | $554 | $286 per seat | $554 per seat |
| Paddle fee per month | ~$17.70 | ~$28.20 | ~$14.30 per seat + $0.50 | ~$27.70 per seat + $0.50 |
| Stripe fee per month | ~$14.40 | ~$23 | ~$11.70 per seat + $0.30 | ~$22.70 per seat + $0.30 |

These fees are a cost of every plan, so the final plan prices must cover them.

## Competition

| Tool | Accounts and security |
| --- | --- |
| HubSpot | SSO (SAML) and audit logs only on Enterprise (~$150 per seat, 10-seat minimum in one source) |
| Most real-estate CRMs | Email + password, sometimes Google; two-step sign-in varies; SSO rarely offered |

**Where Turf wins:** two-step sign-in for every role; SSO included on Pro rather than behind a $150-a-seat enterprise tier; a visible audit log; data never deleted for a late payment.

Sources: [Stripe pricing 2026 (Flexprice)](https://flexprice.io/blog/stripe-pricing-breakdown-2026) · [Stripe costs (EightX)](https://eightx.co/blog/compare/how-much-does-stripe-cost) · [Stripe's real cost for software (Freemius)](https://freemius.com/blog/stripe-transaction-fees-real-cost/) · [Paddle vs Lemon Squeezy (Dodo Payments)](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/) · [Paddle vs Lemon Squeezy 2026 (Rework)](https://resources.rework.com/tools/billing-revenue/paddle-vs-lemon-squeezy) · [HubSpot SSO and audit logs (Docsie)](https://www.docsie.io/solutions/vs/hubspot_kb-vs-slab-enterprise/) · [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)

## Amounts, cost and selling price

| | Free trial | Solo (1) | Duo (2) | Team (3+) | Pro (3+) |
| --- | --- | --- | --- | --- | --- |
| Email / Google sign-in | ✅ | ✅ | ✅ | ✅ | ✅ |
| Two-step sign-in | ✅ | ✅ | ✅ | ✅ (required for owners and admins) | ✅ (can be required for everyone) |
| Signed-in devices | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Audit log** | ❌ | 30 days | 30 days | 1 year | 2 years + export |
| **Single sign-on (SSO)** | ❌ | ❌ | ❌ | ❌ | ✅ |
| Invoices, prorated seats, failed-payment retries | — | ✅ | ✅ | ✅ | ✅ |
| **Cost to Turf** (excluding payment fees) | ~$0 | ~$0 | ~$0 | ~$0 | ~$0 |
| **Payment fees** | — | See the table above | See the table above | See the table above | See the table above |
| **Selling price of this feature** | Free | **Included ($0)** | **Included ($0)** | **Included ($0)** | **Included ($0)** |

**Why $0:** accounts and billing are how customers pay, not something they pay for. The payment fee is the cost to plan for: about 5% of every plan's price plus $0.50 per payment.
