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

## Visual benefit storytelling revision

Owner clarified that removing app screenshots should lead to designed marketing scenes rather than text-only sections. Replaced the three plain text columns with alternating editorial compositions containing original architectural illustrations: scattered records to an ordered list; a call with useful context; and a connected follow-up path. Kept the actual app image count at one. Preview-only call assistance and team behavior remain clearly described.

Build and pricing tests passed. Browser checks decoded all three illustration assets, verified the single app image, nine live-text sequence labels, feature links and absence of overflow/runtime errors at 360/390/768/1024/1440px in light/dark. Desktop/mobile light/dark captures refreshed in `qa/`. Reviewed the illustration assets against the existing warm architectural direction. Concept scenes are not represented as actual UI.

## Human photography revision (current)

Owner selected natural human problem-solving moments over 3D illustrations. Replaced all three benefit illustrations with generated editorial photographs of organizing records, listening on a supported call, and passing context to a colleague. Preserved the hero architecture, layout, HTML captions, preview boundaries and single actual app screenshot. Removed superseded 3D assets from the public build.

Reviewed the generated people scenes and refreshed desktop/mobile review captures. Faces and work gestures remain visible; badges sit over the quiet lower portions of photos. Client/SSR build, all 13 prerendered outputs and existing pricing test passed. Chromium checks passed at 360/390/768/1024/1440px in both themes: three decoded photos, one actual app image, working feature destinations, no page overflow or runtime exceptions. Final result remains passed for this local homepage scope; no deployment or authenticated-service verification is implied.

## Persistent entry point

Added a fixed Get started button to public marketing pages and a native modal chooser for Sign in, invitation-based Sign up, and Get the desktop app. Signed-in visitors get Open web dashboard; app download links lead to the existing authorized dashboard, with an anchor on its download heading. No public binary link or authorization bypass was introduced. A waitlist link remains available without an invitation. The footer reserves space for the floating control.

Build/pricing tests passed. Desktop (1440px) and phone (390px), each light/dark: verified viewport-fixed visibility after scrolling, dialog opening, keyboard focus containment, Escape dismissal with trigger focus restoration, body scroll restoration, waitlist navigation, signup navigation, and correct signin/download destinations. The floating control is omitted from account pages. Captures retained as `qa/get-started-*.webp`; full homepage captures refreshed. Actual authentication and download issuance still depend on the existing backend and were not tested live.

## Responsive and motion repair

Reproduced and fixed: 320–360px hero text clipped inside its container despite no page scrollbar; 320px pricing-builder overflow from grid min-content sizing; expanded navigation growing the sticky header to roughly 470px; and tablet hero text/links losing contrast over the photo. The hero now sizes to phone width, uses separated copy/image through compact desktops, and tablet stories/proof stack where needed. Navigation overlays the page in a bounded scroll panel. The chooser fits short landscape screens, with a sticky close control. Enlarged text can reflow; phone inputs use readable 16px text.

Added finite hero/photo entrances, one-time workspace/story reveals, menu/dialog/backdrop entrances, control feedback and progressive FAQ expansion. Reduced-motion preference disables these immediately; content remains visible when the preference changes or IntersectionObserver is unavailable. No looping decoration, scroll hijacking or moving photograph behind reading text.

Validation: 17 browser regressions passed, followed by 2 additional dark-mode/FAQ and enlarged-text checks. Coverage includes public routes at 320/360/390/600/760/768/960/1024/1440/1920px, short 844×390 landscape and 320×568 portrait, genuine text-range bounds, menu resize behavior, focus/scroll restoration, animation completion, reduced motion, unavailable observer, keyboard FAQ operation and one-app-image count. Screenshots refreshed at 320/390/768/1440px in light/dark. Chromium is the verified browser; actual Safari/Firefox/device testing is not claimed. `qa/home-motion.webm` records the motion example.

Reproduce: `npm ci`, then `npx playwright install chromium` and `npm run test:browser`. With an installed system Chromium, use `CALLERWHALE_BROWSER_EXECUTABLE=/usr/bin/chromium npm run test:browser`. The browser suite starts its own Vite server on port 5205. Standard `npm test` still runs the pricing model checks.

Final frozen/offline dependency installation passed with the pinned browser-test dependency; client/SSR build and all 25 pricing-model tests passed. Existing platform-specific lockfile metadata was preserved.
