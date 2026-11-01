# Homepage implementation review

Date: 2026-11-01. Scope: landing-web homepage and shared marketing header, footer, theme and waitlist. The broader web rebuild is not complete.

Final result: passed for this local homepage implementation.

## Visual comparison

Compared the preserved selected property-outreach concept with the rendered homepage at 1440px, including the same hero and product-proof state. Reviewed full-height mobile/desktop light/dark screenshots in `qa/`.

- Preserved warm ivory/charcoal/peach, condensed HTML headings, fine rules, restrained controls, layered residential imagery, and genuine adjacent product evidence.
- Preserved the actual production whale mark rather than the concept's invented wordmark. Hero uses a separate generated architectural asset; software screenshots come from the current app.
- Continued the selected visual system through every planned homepage section, replacing the old repeated feature/pricing card wall.
- At mobile sizes, text/actions precede the image, workflow becomes a compact vertical list, and stories stack copy before evidence.
- Dark mode uses separate surface tokens and keeps screenshots/photo colors intact. The architecture is dimmed slightly for text contrast.
- Fixed P1 mobile workflow typography override, P1 menu contrast, P2 doubled scroll offset on the legacy waitlist anchor, and local preview contact-routing/clean-URL hydration defects. No remaining P0–P2 findings in the reviewed homepage scope.

## Executed checks

- `SITE_URL=https://callerwhale.com npm run build`: client/SSR build and all 13 prerendered pages passed.
- `npm test`: existing pricing test file passed. Its internal assertions are not reported as separate test-runner tests.
- Chromium/Playwright: 360, 390, 768, 1024 and 1440px, each light/dark, reduced motion. No page overflow or runtime exceptions. Loaded/decoded every lazy product image before final capture.
- Mobile menu expanded state, Escape dismissal/focus restoration, independent FAQ disclosure, workflow/access/legacy waitlist anchors, pricing navigation and persisted theme verified.
- Waitlist browser checks: required email, busy/disabled submit, retained input after 429 and network failure, accepted and duplicate states. Error/busy cases used mocked responses.
- Actual local landing API, disposable database outside the repo: accepted and duplicate submissions passed through Vite. No real email was delivered or claimed.
- Production preview: public/account-entry page navigation and hydration, homepage content/FAQ without JavaScript, enlarged-text reflow. The local auth backend is not running; sign-in reports a connection failure, so authenticated behavior is unverified. No production deployment or live CSP/CORS/auth audit is implied.

## Remaining scope

Other public-page compositions, route-registry consolidation, account/dashboard work, deployed discovery/CSP/CORS and production approval remain later work packages. This implementation does not open registration, change authentication, implement billing, or enable live telephony. Existing source claims on other pages need their own planned review.

P3: font swap can briefly change heading metrics on first load; the licensed local font uses `font-display: swap`. Product images open their full-size asset in a new tab for inspection rather than adding a modal viewer.

## Reproduction

From `landing/web`: `npm ci`, `npm run dev` (port 5200). Start the existing API with `CALLERWHALE_LANDING_DB` pointing to disposable local storage and `npm --prefix ../api start`. Production: build with SITE_URL, then `npm run preview`. Browser tooling and original run artifacts for this session are under `/workspace/turf-qa` and `/workspace/browser-tools`; the four review captures are retained in `qa/`.

## Homepage imagery revision

Owner feedback: show the app once or twice at most on the homepage. The homepage now contains exactly one app image (Calls, in workspace proof). The three product stories are text-led columns on desktop and stacked rows on phones. Existing screenshots remain available to the Features page.

Revalidated the build and existing tests, then checked one app image, three stories and no page overflow at 390/768/1440px in both themes. Refreshed all four retained review captures. No additional API behavior changed.
