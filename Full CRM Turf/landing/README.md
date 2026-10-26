# Landing site

The public site that sells Turf (Phase 1 of `docs/plans/service-architecture.md`). Two parts, each with its own folder and nothing shared at run time.

| Folder | What | Stack |
| --- | --- | --- |
| `web/` | The site: Home, Features, Pricing, Why Turf, Security, Contact, Privacy, Terms | React + Vite, the app's design tokens. No secrets. |
| `api/` | `POST /api/waitlist`, `POST /api/contact`, `POST /api/hit`, `GET /api/stats`, `GET /api/download`, `GET /healthz`; also serves the built site | Node 24+, no dependencies, its own SQLite file (`api/data/landing.db`, git-ignored) |

## Pages

Routes use the URL hash (`#/features`, `#/features#map`), so the site is one static file set with no server rules.

| Page | Source of its text |
| --- | --- |
| Home | Hero, the five tools Turf replaces, feature cards, a tour of four screens, how it works, audiences, plans, FAQ |
| Features | One section per feature in `docs/features/`, each with its screen, what works today, and what is coming |
| Pricing | Draft prices from `docs/plans/README.md`. A plan is the sum of its features. Checkout is off |
| Why Turf | One app instead of five, with a list of where Turf is limited. Competitors are not named and no competitor prices are quoted |
| Security | What `docs/features/09-accounts-security-billing.md` says is built, and what is not |

All copy lives in `web/src/content.js`. Every feature and security point carries a status: **In the app now**, **In preview** (works with sample data) or **Coming at launch**. Keep these honest: change the status when the work lands.

## Screenshots

`web/public/screens/*.webp` are captures of the CRM in its sample workspace. To refresh them after the app changes, start the CRM (`npm run dev` in `Full CRM Turf`), then:

```bash
node landing/web/scripts/capture-screens.mjs http://localhost:5190 shots
```

Convert the PNGs to WebP (quality 82) and copy them into `web/public/screens/`.

## Run it

```bash
npm --prefix landing/api start        # http://localhost:8095
npm --prefix landing/web run dev      # http://localhost:5200, proxies /api to the API
```

Test and build:

```bash
npm --prefix landing/api test
npm --prefix landing/web run build    # landing/web/dist
```

## Settings

| Variable | Where | Meaning |
| --- | --- | --- |
| `PORT` | api | Default 8095 |
| `TURF_LANDING_DB` | api | SQLite file, default `data/landing.db` |
| `TURF_RELEASE_REPO` | api | `owner/repo` whose latest published GitHub release feeds the Download button. Unset: "coming soon" |
| `TURF_LANDING_ORIGINS` | api | Comma-separated sites allowed to call the API from a browser (default the dev site) |
| `TURF_LANDING_WEB_DIR` | api | Folder of the built site to serve. Default `landing/web/dist` |
| `TURF_LANDING_STATS_TOKEN` | api | Bearer token for `GET /api/stats` (page views per page for 30 days, and the waitlist count). Unset: stats are off |
| `VITE_TURF_SIGNUP_URL` | web, at build | If set, the header shows a "Sign in" link to it (the account site, once it is public) |

## What it does not do yet

- No checkout (billing is deferred), so prices are labelled drafts.
- Waitlist and contact messages are stored, not emailed. Sending the confirmation goes through the notification service (Phase 5).
- Sign-up for an account stays on the existing server's site until the auth service exists (Phase 4).
- Privacy and Terms are short drafts and must be reviewed before the product is sold.
- Hash routes are fine for people, but search engines index them poorly. Before a real launch, move to path routes with a fallback in the web server, and pre-render the pages.
- No analytics and no cookie banner yet.
