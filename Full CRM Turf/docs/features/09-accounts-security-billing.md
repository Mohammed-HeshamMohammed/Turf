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

**Not built yet:** the Paddle and Stripe connections (both chosen, see below), a `provider` column on subscriptions and payments, invoices and receipts, sales tax, failed-payment retries, plan changes mid-month, cancellation and the 30-day data window (Feature 8), single sign-on (SSO), an audit-log screen, and a "signed-in devices" screen.

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

## Payment providers: Paddle and Stripe, plus manual invoices

**Decided (2026-10-25): support both, and more where needed.** Each workspace is billed by one provider at a time; the server keeps a `provider` on every subscription and payment and checks each provider's own signed webhook.

| | **Paddle** (merchant of record) | **Stripe** | **Manual invoice** |
| --- | --- | --- | --- |
| Used for | **Default checkout**: monthly and annual card payments on every tier | **Bank debit (ACH)** and invoices for annual plans and big teams | Large or enterprise deals paid by bank transfer |
| Fees | **5% + $0.50 per payment, all-in** | Cards 2.9% + $0.30 (+0.7% Billing, +0.5% Tax); **ACH 0.8%, capped at $5**; failed ACH $4; disputes $15; inbound wire $8 | Bank fees only |
| **Who owes the sales tax** | **Paddle** (seller of record: US sales tax and foreign VAT) | **Turf** | **Turf** |
| Payment methods | Cards; Paddle also offers wallets such as PayPal (check Paddle's current list) | Cards, ACH bank debit, wire | Bank transfer |
| How a payment is confirmed | Paddle's signed webhook | Stripe's signed webhook | A platform administrator (with MFA) marks it paid; the action is audit-logged |

**Why both:** Paddle keeps everyday sales simple, with no sales-tax filing. Stripe's bank debit makes big annual deals far cheaper: a $10,000 annual invoice costs **$5 by ACH** against about $290 by card.

### Sales tax when Turf bills directly (Stripe and manual invoices)

- Software subscriptions are taxable in some form in **about 26 US states**, and California is reported to start taxing software in January 2027.
- A state's tax duty starts once Turf's sales into it pass that state's **economic nexus threshold**: most states use **$100,000 a year**, some also count transactions, and California, Texas and New York use $500,000. Several states have dropped the 200-transaction test.
- Sales through Paddle are Paddle's, so they do not count toward Turf's own thresholds as a seller.
- So: run Stripe Tax (0.5%) on Stripe sales to track each state, register in a state only when Turf's direct sales there approach its threshold, and have an accountant confirm. Exempt sales can still count toward a threshold.

**Annual billing** cuts the fixed $0.30–0.50 per payment to once a year and is worth offering at a discount.

Which methods customers can use in the US, Canada, Latin America, Europe and Africa, and who owes the tax in each: [Payment methods by region](../plans/payment-methods-by-region.md).

**No crypto.** Egypt's Central Bank law (No. 194 of 2020, Article 206) bars issuing, trading or promoting crypto without a licence, and no licences have been issued. It applies to the founder living in Egypt whatever country the company is in.

## Company setup

Turf is run from Egypt. Stripe is not open to businesses registered in Egypt, and US texting registration, Telnyx and US contracts all go more smoothly for a US company, so:

| Piece | Choice | Check before launch |
| --- | --- | --- |
| Company | **US LLC** (Wyoming or Delaware), through Stripe Atlas, doola or Firstbase | That the formation service accepts founders living in Egypt |
| Bank | Mercury or Wise, in the LLC's name | That they accept owners living in Egypt (Mercury refuses founders in some countries) |
| Checkout | Paddle (default) and Stripe, both paying out to the LLC | That Paddle accepts the LLC as a seller |
| US filings | Even with no US income tax, a foreign-owned single-member LLC files **Form 5472 with a pro forma Form 1120 every year**; missing it costs **$25,000 per form per year**, and money put into the company counts as a reportable transaction | A US accountant |
| Egyptian tax | Egypt treats a foreign company as **Egyptian-resident** when its real management is in Egypt (at least two of: daily decisions made there, managers' meetings held there, half the managers living there; some summaries add owners of more than half living there). A resident company is taxed on worldwide profits at **22.5%**, wherever its bank accounts are. | An Egyptian tax adviser, including the US–Egypt tax treaty |

Non-Egyptian bank accounts don't change the Egyptian management rule; plan for it rather than around it.

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

Sources: [Egypt corporate residence (PwC)](https://taxsummaries.pwc.com/egypt/corporate/corporate-residence) · [Egypt income tax executive regulation (WIPO)](https://www.wipo.int/wipolex/es/text/577252) · [Egypt international corporate tax (Moore Global)](https://www.moore-global.com/services/tax/international-corporate-tax/egypt/) · [Form 5472 penalty (Taxes for Expats)](https://cdn.taxesforexpats.com/articles/foreign-business/form-5472-penalty.html) · [Form 5472 for foreign-owned businesses (SDO CPA)](https://www.sdocpa.com/form-5472-foreign-owned-business-filing/) · [Mercury eligibility (private.law wiki)](https://wiki.private.law/en/mercury) · [Stripe for Egyptian businesses (Osome)](https://osome.com/uk/blog/stripe-verified-business-egypt) · [Legality of cryptocurrency in Egypt (Andersen)](https://eg.andersen.com/legality-cryptocurrency-in-egypt/) · [10DLC brands for non-US companies (Infobip)](https://www.infobip.com/docs/10dlc/brands) · [Stripe ACH fees (Dodo Payments)](https://dodopayments.com/blogs/stripe-ach-fees/) · [Stripe fees explained 2026](https://transferfees.io/guides/stripe-fees-explained/) · [SaaS sales tax statistics (Anrok)](https://www.anrok.com/resources/sales-tax-statistics) · [Economic nexus by state (Taxually)](https://www.taxually.com/blog/economic-nexus-by-state) · [Sales tax nexus for SaaS (Dodo Payments)](https://dodopayments.com/blogs/sales-tax-nexus-saas-when-to-collect) · [SaaS sales tax by state 2026 (Numeral)](https://numeral.com/blog/sales-tax-on-saas) · [Stripe pricing 2026 (Flexprice)](https://flexprice.io/blog/stripe-pricing-breakdown-2026) · [Stripe costs (EightX)](https://eightx.co/blog/compare/how-much-does-stripe-cost) · [Stripe's real cost for software (Freemius)](https://freemius.com/blog/stripe-transaction-fees-real-cost/) · [Paddle vs Lemon Squeezy (Dodo Payments)](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/) · [Paddle vs Lemon Squeezy 2026 (Rework)](https://resources.rework.com/tools/billing-revenue/paddle-vs-lemon-squeezy) · [HubSpot SSO and audit logs (Docsie)](https://www.docsie.io/solutions/vs/hubspot_kb-vs-slab-enterprise/) · [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)

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
