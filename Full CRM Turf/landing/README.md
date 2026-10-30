# Landing site

The public site that sells Caller Whale (Phase 1 of `docs/plans/service-architecture.md`). Two parts, each with its own folder and nothing shared at run time.

| Folder | What | Stack |
| --- | --- | --- |
| `web/` | The site: Home, Features, Pricing, Why Caller Whale, Security, Contact, Privacy, Terms | React + Vite, the app's design tokens. No secrets. |
| `api/` | `POST /api/waitlist`, `POST /api/contact`, `GET /healthz` | Node 24+, no dependencies, its own SQLite file (`api/data/landing.db`, git-ignored) |

## Accounts

The header has **Sign in** and **Sign up** (Firebase: email and password, or Google). The site asks the core API what the signed-in person may see: `/dashboard` (credits, usage and the download) only for people Caller Whale invited, `/admin` (invite, set limits, suspend, watch usage) only for Caller Whale's staff. See `docs/plans/callerwhale-launch.md`. The sign-in client is `src/auth/firebase-auth-client.js`, a copy kept in step by `services/auth/clients/sync.mjs`; the Firebase SDK is loaded only when someone signs in.

## Pages

Real paths (`/features`, `/features#map`). `npm run build` writes every page as plain HTML into its own folder (`dist/pricing/index.html`) and the browser hydrates it, so search engines, link previews and visitors without scripts see the content. `landing/api` serves `dist` and its `404.html`. Set `SITE_URL` when building to add canonical links, `sitemap.xml` and the `Sitemap` line in `robots.txt`.

| Page | Source of its text |
| --- | --- |
| Home | Hero, the five tools Caller Whale replaces, feature cards, a tour of four screens, how it works, audiences, plans, FAQ |
| Features | One section per feature in `docs/features/`, each with its screen, what works today, and what is coming |
| Pricing | A plan builder (the team size, each of five features Off / Standard / Power with its own number of people, extras, a live total) over the draft prices from `docs/plans/README.md`, then four ready-made plans, ten more (List Cleaner, Data Desk, Caller, Call Floor and others, each openable in the builder) and a comparison table. The CRM is a free base in every plan, and one person pays at most $179 a month for features (the all-in price). The cap lowers the software part only, never the metered costs. See `docs/plans/positioning.md`. The arithmetic is in `web/src/plan.js` with tests in `web/tests`. Checkout is off. See `docs/plans/custom-plans.md` |
| Why Caller Whale | One app instead of five, with a list of where Caller Whale is limited. Competitors are not named and no competitor prices are quoted |
| Security | What `docs/features/09-accounts-security-billing.md` says is built, and what is not |

All copy lives in `web/src/content.js`. Every feature and security point carries a status: **In the app now**, **In preview** (works with sample data) or **Coming at launch**. Keep these honest: change the status when the work lands.

## Screenshots

`web/public/screens/*.webp` are captures of the CRM in its sample workspace. To refresh them after the app changes, start the CRM (`npm run dev` in `Full CRM Turf/desktop/frontend/react`), then:

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
SITE_URL=https://your-domain npm --prefix landing/web run build    # landing/web/dist, prerendered
```

## Settings

| Variable | Where | Meaning |
| --- | --- | --- |
| `PORT` | api | Default 8095 |
| `TURF_LANDING_DB` | api | SQLite file, default `data/landing.db` |
| `TURF_RELEASE_REPO` | api | `owner/repo` whose latest published GitHub release feeds the Download button. Unset: "coming soon" |
| `TURF_LANDING_ORIGINS` | api | Comma-separated sites allowed to call the API from a browser (default the dev site) |
| `VITE_TURF_API_URL` | web, at build | Caller Whale's server (the core API) the site signs in against and gets dashboards from. Default `http://localhost:8088` in development; the Dockerfile defaults to `https://app.callerwhale.com` |
| `FIREBASE_AUTH_HOST` | web container | The Firebase project's `<id>.firebaseapp.com`. nginx serves its sign-in helper at `/__/auth/` on the site's own address |
| `API_ORIGIN` | web container | The core API's origin, allowed by the site's content security policy |

## What it does not do yet

- No checkout (billing is deferred), so prices are labelled drafts.
- Waitlist and contact messages are stored, not emailed. Sending the confirmation goes through the notification service (Phase 5).
- Sign-up for an account stays on the existing server's site until the auth service exists (Phase 4).
- Privacy and Terms are short drafts and must be reviewed before the product is sold.
- Page views are counted by `landing/api` without cookies (a day, a page and a count; skipped when the browser sends Do Not Track). Read them with `GET /api/stats` and the stats token. There is no cookie banner because nothing needs one.
- Set `SITE_URL` for the real domain at build time, or canonical links and the sitemap are left out.
