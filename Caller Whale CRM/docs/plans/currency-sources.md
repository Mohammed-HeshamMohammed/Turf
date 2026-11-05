# Currency: where each piece comes from

**Status:** Built, 2026-11-05. The rule: use the official or community data for what is a fact about the world, and write our own code only for what is ours.

| Piece | Source | Why this one | Where it lives |
| --- | --- | --- | --- |
| Which currencies exist, and how many decimals each has | **ISO 4217**, from SIX (the standard's maintenance agency): [list-one.xml](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml) | It is the standard itself, free, and dated (published 2026-09-17 when last fetched) | `tools/currency-data.mjs` writes `landing/site/src/currency-data.ts` and `services/auth/currency_data.go` |
| Which currency each country uses now | **Unicode CLDR** (`cldr-core` on npm, from [unicode-org/cldr-json](https://github.com/unicode-org/cldr-json)), version 49 when last fetched | Dated history per country, so a switch (Croatia to the euro in 2023, Bulgaria on 2026-01-01) is picked up | same generated files |
| Today's exchange rates | **fawazahmed0/exchange-api**, served by jsDelivr, no key, about 300 currencies, with a second host as a fallback | No key, includes currencies the ECB feed lacks (EGP, AED, SAR) | `services/auth/fx.go`, cached six hours, `GET /v1/fx` |
| Where the visitor is | **Cloudflare**'s `CF-IPCountry` header (already in front of the site) | Free, no lookup service to run | `services/auth/fx.go` |
| What a customer is charged, local currency and tax | **Paddle** (and later **Stripe**), see [paddle-localized-prices.md](paddle-localized-prices.md) | A merchant of record owns this, not us | planned |

## Looked at and not used

- **`golang.org/x/text/currency`** (Go): its tables are from CLDR 32 (2018). Tested in this repository: it says Croatia uses the kuna, Sierra Leone the old leone and Venezuela the old bolívar, and rejects the current codes SLE and VES. The decimals are right, the countries are not.
- **Frankfurter** (ECB rates, open source, can be self-hosted): good and reliable, but about 30 currencies, without Egypt, the Gulf states and others. A sensible second source if the first ever goes away; the cache already serves the last good rates meanwhile.
- **Open-source billing (Lago, Kill Bill, OpenMeter):** they meter usage and make invoices. None of them is a merchant of record, so none calculates or owes the tax; that stays Paddle's (or, with Stripe, ours).

## Keeping it right

- A monthly workflow (`.github/workflows/currency-data.yml`) fetches both standards again and fails when the committed tables are behind. To fix it: `node tools/currency-data.mjs`, then commit the two files it writes.
- The Go and TypeScript tests pin the countries that changed currency, and check that every country's currency is in the list.
- Exchange rates are for showing and for the owner's own sums, never for what a customer is charged.
