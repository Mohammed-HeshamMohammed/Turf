# Landing site

The public page of Caller Whale: a home page, account pages and a signed-in dashboard at `/dashboard`, signing in through the auth service (`services/auth`). React, TypeScript and Tailwind CSS on Vite, in the desktop app's style; no secrets.

| Setting | Meaning |
| --- | --- |
| `VITE_CALLERWHALE_AUTH_URL` | Auth service address, set at build. Development default `http://localhost:8101` |
| `VITE_CALLERWHALE_GATEWAY_URL` | Public gateway origin for the contact form, set at build. Default `https://gate.callerwhale.com` |

```bash
npm --prefix landing/site run dev      # http://localhost:5200
npm --prefix landing/site run build    # landing/site/dist
```

`src/auth/auth-client.js` and `human-check.jsx` are copies of `services/auth/clients/`, kept in step by `node services/auth/clients/sync.mjs`. When the auth service has bot protection on, the forms load the invisible human check on their own.

Sign-up answers "by invitation" while the auth service has `AUTH_PUBLIC_SIGNUP=false`. Google sign-in comes back to `/signin` (`AUTH_LANDING_URL` on the auth service). Deploy: Dockerfile in this folder, port 8080.

**Health and logs.** The image probes `http://127.0.0.1:8080/healthz` every 30 seconds. In Coolify, configure the application health check as HTTP `GET /healthz` on port `8080` so its Healthcheck indicator also reports status. nginx emits JSON request records to stdout; the shared `callerwhale-log` runner formats them, suppresses successful health probes, and keeps failures visible. nginx errors go to stderr through the same runner.

**Delivery.** The browser hydrates the prerendered HTML. The home page preloads its hero image, text assets are gzip compressed, fingerprinted `/assets/` files are cached for a year, and `/screens/` images are cached for an hour with background revalidation.

**State.** The page follows who is signed in: the header and home page wait until that is known, someone signed in is sent from sign-in to `/dashboard`, nobody signed in is sent from `/account` or `/dashboard` to sign in, and a sign-in or sign-out in another tab (or a session the server ended) is picked up at once. The rules are in `src/guard.ts`. The dashboard reads the signed-in person's own memberships and platform role through auth's `/v1/me/access` endpoint; it reports unavailable data without pretending a missing connection means no memberships. Owner, cofounder, and system admin see the staff dashboard after a second step; owner and cofounder can change system admin and tester roles by email. The old invitation, credit usage, and Grafana panels depended on the retired core API and are not wired here.

**Profile.** `/account` edits the display name, optional phone, and a small PNG/JPEG picture through auth. It shows platform and workspace roles as badges and reads linked Google/Apple methods from Firebase. Connecting a new provider uses a recent signed-in session and returns to the same account after Firebase confirms the link.

**Security.** nginx sends a content security policy that lets the page talk only to the auth service, plus clickjacking, content-type, referrer, permissions and HSTS headers. `scripts/security-headers.mjs` writes them when the image is built, from the same `VITE_CALLERWHALE_AUTH_URL`, and the build stops if it is missing, not https, or has a path. `npm test` runs the checks (also in the image build). If the auth service turns on the human check (reCAPTCHA), the policy already allows Google's script and frame.

**Code.** TypeScript (`.ts`, `.tsx`), type-checked with `npm run typecheck` and on every build. Tailwind CSS 4 is on: its utilities (`mt-4`, `grid`, `text-accent-ink`) work anywhere, and the site's colours are Tailwind colours (`bg-card`, `text-ink`, `border-line`, `bg-accent`, see `src/app.css`). Tailwind's resets are left off so the existing styles look the same; those styles sit in a lower layer, so a utility class always wins over them. `src/auth/auth-client.js` and `human-check.jsx` stay JavaScript because they are copies kept in step with the other apps (`*.d.ts` beside them describes their types). The tests run TypeScript directly, so Node 24 or newer.

**Pages and search.** `src/routes.ts` is the one list of pages (address, title, description, whether to index). The build (`npm run build`) writes every page as finished HTML into its own folder (`scripts/prerender.mjs`), with its title, description, canonical address, link-preview tags and structured data (organization, website, and the pricing questions as an FAQ), plus `sitemap.xml` and `robots.txt`. Sign-in, sign-up, reset, account and dashboard pages are marked noindex and left out of the sitemap. An address that is not on the list answers a real 404. To add a page: add its route, add its component to `pages` in `src/App.tsx`.

**Pricing.** `src/Pricing.tsx` and `src/pricing/`: the plan builder, the ready-made plans and the price table, restored from the earlier site. `src/pricing/content.ts` holds the draft prices and the questions; `src/pricing/plan.ts` does the arithmetic (tests in `tests/plan.test.mjs`). Checkout is off.
