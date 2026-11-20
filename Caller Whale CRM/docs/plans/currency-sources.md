# Currency: where each piece comes from

**Status:** Built, 2026-11-05. The rule: use the official or community data for what is a fact about the world, and write our own code only for what is ours. **Everything is live**: nothing about currencies is frozen at build time, and the copy in the repository is only what the server knows until it has fetched the standards.

| Piece | Source | Why this one | Where it lives |
| --- | --- | --- | --- |
| Which currencies exist, and how many decimals each has | **ISO 4217**, from SIX (the standard's maintenance agency): [list-one.xml](https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml) | It is the standard itself, free, and dated (published 2026-09-17 when last fetched) | **Live:** the auth service fetches it once a day while it runs (`services/auth/currency_live.go`) and sends it to the browser with the rates. **Snapshot** (fallback): `tools/currency-data.mjs` writes `apps/website/src/currency-data.ts` and `services/auth/currency_data.go` |
| Which currency each country uses now | **Unicode CLDR** (`cldr-core` on npm, from [unicode-org/cldr-json](https://github.com/unicode-org/cldr-json)), version 49 when last fetched | Dated history per country, so a switch (Croatia to the euro in 2023, Bulgaria on 2026-01-01) is picked up | same: live daily, snapshot as the fallback |
| Today's exchange rates | **fawazahmed0/exchange-api**, served by jsDelivr, no key, about 300 currencies, with a second host as a fallback | No key, includes currencies the ECB feed lacks (EGP, AED, SAR) | `services/auth/fx.go`, cached six hours, `GET /v1/fx` |
| Where the visitor is | **Cloudflare**'s `CF-IPCountry` header (already in front of the site) | Free, no lookup service to run | `services/auth/fx.go` |
| What a customer is charged, local currency and tax | **Paddle** (and later **Stripe**), see [paddle-localized-prices.md](paddle-localized-prices.md) | A merchant of record owns this, not us | planned |

## Looked at and not used

- **`golang.org/x/text/currency`** (Go): its tables are from CLDR 32 (2018). Tested in this repository: it says Croatia uses the kuna, Sierra Leone the old leone and Venezuela the old bolívar, and rejects the current codes SLE and VES. The decimals are right, the countries are not.
- **Frankfurter** (ECB rates, open source, can be self-hosted): good and reliable, but about 30 currencies, without Egypt, the Gulf states and others. A sensible second source if the first ever goes away; the cache already serves the last good rates meanwhile.
- **Open-source billing (Lago, Kill Bill, OpenMeter):** they meter usage and make invoices. None of them is a merchant of record, so none calculates or owes the tax; that stays Paddle's (or, with Stripe, ours).

## What "live" means here

- **Exchange rates:** fetched again after six hours, last good rates served if the source is down.
- **Currencies, decimals, each country's currency:** fetched again after a day, in the background (nobody waits for it). If the fetch fails, or what it returns looks wrong (too few currencies or countries), the last good tables stay and it tries again after 15 minutes. A country that changes currency, or a currency that is retired, is followed without a release.
- **The visitor's country:** read from each request.
- **The browser:** takes the server's live tables with the rates and uses them from then on (the dropdown list, the default currency, the decimals); what shipped with the page is used only until they arrive.
- **The snapshot** exists so a fresh start, a source outage or an offline page still has correct tables. The monthly check below keeps it from falling behind.

## Keeping it right

- A monthly workflow (`.github/workflows/currency-data.yml`) fetches both standards again and fails when the committed tables are behind. To fix it: `node tools/currency-data.mjs`, then commit the two files it writes.
- The Go and TypeScript tests pin the countries that changed currency, and check that every country's currency is in the list.
- Exchange rates are for showing and for the owner's own sums, never for what a customer is charged.
