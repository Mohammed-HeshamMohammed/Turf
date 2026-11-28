# Exact prices in the visitor's currency, with tax, from Paddle

**Status:** Proposed, updated 2026-11-05 with your decisions: **build and test in Paddle's sandbox now, then add Stripe (in its test mode) the same way.** Nothing here is built.

**Where currency lives today (built):** the pricing page shows plain US dollars and has no currency chooser. A person's *main currency* is an account setting (Profile, beside the connected accounts): automatic from where they are (the country Cloudflare sees, then their language) until they choose one. It is what their Costs rows and overview are shown in. Exchange rates (auth, `GET /v1/fx`) are for those dashboard sums only, never for what a customer is charged.
**Date:** 2026-11-05

## Goal

A visitor who builds a plan sees what will actually be taken from them: the amount in their currency, the sales tax or VAT for their country, and the total, before they press anything, with **no chooser on the pricing page**: the currency and country are worked out automatically from where the visitor is (their IP address, which Paddle reads). Checkout then charges exactly that. Caller Whale never works out tax itself: Paddle is the merchant of record, so it owes and calculates the tax.

## What Paddle gives us (from its documentation)

- **Local currency is a Paddle setting, in two ways that can be combined.** *Automatic currency conversion* (switched on per currency in the Paddle dashboard) converts the base price for matching customers. *Price overrides* set a fixed price for chosen countries. The order is country override, then automatic conversion, then the base price. Paddle supports about 30 currencies, not every currency the dropdown offers. [Offer localized pricing](https://developer.paddle.com/build/products/offer-localized-pricing), [Supported currencies](https://developer.paddle.com/concepts/sell/supported-currencies). Vietnam is a known exception: it needs an explicit override to show Dong.
- **A pricing page asks Paddle.** `Paddle.PricePreview()` (Paddle.js) takes price IDs plus a country or the visitor's IP address and returns localized totals, including tax, already formatted for the currency (`formattedTotals`). It needs only Paddle's *client-side token*, which is public by design. [Build a pricing page](https://developer.paddle.com/build/checkout/build-pricing-page), [Pricing preview API](https://developer.paddle.com/api-reference/pricing-preview).
- **Custom amounts exist, with a catch.** Paddle can bill "non-catalog" prices (an amount made up for one transaction), and the *transaction preview* API accepts them. We found no statement that the lighter *pricing preview* accepts them too. [Create custom items, prices and products](https://developer.paddle.com/build/transactions/bill-create-custom-items-prices-products), [Preview a transaction](https://developer.paddle.com/api-reference/transactions/preview-transaction-create). This is the one thing to prove first (step 1).

## The problem to solve first: our plans are not catalog prices

The builder makes any mix of features, people and extras, so there are far too many totals to create as Paddle catalog prices. Two ways through:

| | How | For | Against |
| --- | --- | --- | --- |
| **A (recommended)** | The page sends the *selection* to a Caller Whale endpoint; the server works out the total itself and asks Paddle to preview one non-catalog item for that amount | Any plan works; the amount is ours to control; one Paddle call per preview | A server call per change (rate limited); relies on the transaction-preview behaviour in step 1 |
| B | One catalog price per feature, per tier and per extra, bought as line items with a quantity | Paddle's lighter, public preview works from the browser | The all-in cap ($179 for one person) is a discount across features, which a plain line item cannot express; dozens of prices to keep in step with `plan.ts` |

**The server must be the authority on price.** Today the total is computed in the browser (`apps/website/src/pricing/plan.ts`). A preview or checkout endpoint that accepted an amount from the browser would let anyone pay what they like. So the endpoint takes only the selection (features, levels, people, extras), and the same rules are run on the server. Plan: move the pricing rules into billing (Python, where Paddle already is) with a test that compares it to `plan.ts` on every mix (the existing test already checks every mix and team size), and keep `plan.ts` for the instant on-page estimate.

## Where it runs

- **Billing** gets `POST /api/v1/price-preview` (selection and country in, localized totals out) and holds a new secret, `PADDLE_API_KEY`, used only here.
- **A public address for billing.** Paddle must reach billing's webhook from the internet, and the page must reach the preview, but billing has no public address. Add one (for example `pay.callerwhale.com`): a Cloudflare record, the domain on the gateway app in Coolify, and a gateway route that allows only `/api/v1/plans`, `/api/v1/price-preview` and `/api/v1/billing/webhook`. Everything else of billing stays private. This is the same job the webhook needs anyway.
- **The pricing page** calls the preview when the selection or country changes (debounced), shows the localized subtotal, tax and total, and, if the call fails or the currency is not one Paddle bills in, **falls back to the main price in US dollars** (the list price, labelled as such). It never shows a guessed conversion.

## What the visitor sees

- Total in their currency, then "includes VAT of …" or "plus tax …", from Paddle's answer, not ours.
- No currency or country chooser on the page. Paddle works both out from the visitor's IP address; a visitor who wants another country changes it at checkout.
- A currency Paddle does not support, or any failure to get Paddle's answer: the main price in US dollars, labelled "US dollars". The same rule is already in the dashboard: with no exchange rate for a person's main currency, the overview and the cost rows show US dollars and say so.
- Checkout opens with the same item, so what they saw is what they pay. If it differs (a price changed in between), checkout shows the new one and the page says so.

## What you need to do in Paddle

1. A **Paddle sandbox** account now (live later, with the same steps). Nothing is built against live money until the sandbox flow passes.
2. Turn on **automatic currency conversion** for the currencies you want to bill in, and set **price overrides** for any country where a round local price matters (for example Egypt, Vietnam).
3. Make an **API key** (server side, secret: set it only in Coolify as `PADDLE_API_KEY`) and a **client-side token** (public, for the page).
4. Say which countries you sell to, so tax settings and the country list match.

## Steps, in order

1. **Prove it in the sandbox (half a day).** With a sandbox key: preview a non-catalog item of $179 for Germany, Egypt and the US. Confirm it comes back in euros / pounds / dollars with tax, and that automatic conversion applies to a non-catalog price. This decides A or B; do not build before it.
2. **Price authority.** Port the pricing rules to billing, with the every-mix test against `plan.ts`.
3. **Public billing address** and the gateway allow-list, which also lets Paddle's webhook in.
4. **Preview endpoint** in billing, rate limited per address, with Paddle's answer cached for a minute per selection and country.
5. **Pricing page** wiring, country chooser, and the fallback.
6. **Checkout** with the same server-priced item (separate plan, but it reuses 2 and 4).

## Stripe, second, in its test mode

Stripe is the second provider (bank debit and invoices for annual and large plans, per `docs/pricing-and-market/features/09-accounts-security-billing.md`). Differences that change the work, from Stripe's documentation ([Adaptive Pricing](https://docs.stripe.com/payments/checkout/adaptive-pricing), [Stripe Tax testing](https://docs.stripe.com/tax/testing)):

- **Local currency** is Stripe's *Adaptive Pricing*, switched on in its payment settings separately for the test and live modes. It works with **Checkout Sessions only**, not the Payment Intents API, and needs the prices in a settlement currency. So a Stripe checkout is Stripe's hosted or embedded checkout, not a custom form.
- **Tax stays in your base currency** with Adaptive Pricing: tax calculation, reporting and invoicing are in the integration currency, unlike Paddle, which handles it all.
- **Stripe is not the merchant of record.** Caller Whale owes the sales tax and VAT, so Stripe Tax needs *registrations* added (even in test mode) for the places you collect tax. This is the biggest difference from Paddle and needs an accountant's answer before live.
- **Testing a customer's country** in test mode: use an email with a `+location_XX` suffix (for example `test+location_FR@example.com`) to see the local currency.
- Not confirmed from the sources: how to preview tax before payment outside Checkout. Read Stripe's Tax Calculation API reference at that step.

Order: Paddle sandbox first (steps 1 to 5 below), then Stripe test mode behind the same server-priced selection, so the page shows one answer whichever provider the buyer will use.

## Risks

- **Step 1 fails** (Paddle does not localize custom amounts): fall back to B, or create the few most-used plans as catalog prices and treat the rest as "custom, quoted at checkout".
- **No guessed prices on the pricing page.** The page shows either Paddle's real answer or the main USD price, never an exchange-rate estimate of ours, so a visitor is never shown a number that checkout then changes.
- **Tax is Paddle's call.** Our page can show it but must never promise it: the final tax is set at checkout from the buyer's real details.
- **Abuse of the preview endpoint.** It costs a Paddle call; it needs the per-address limit and the cache.

## Decisions for you

1. Go with approach A if step 1 passes? (Recommended.)
2. Which currencies to bill in, and any countries that need a fixed local price.
3. Paddle sandbox: please create the account and the two keys (API key for the server, client-side token for the page), and tell me when they are in Coolify, never in a chat or a file.
4. Stripe test mode: the same, later, once Paddle's sandbox flow passes.
