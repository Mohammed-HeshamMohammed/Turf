# Landing web detail and publication contract

## Discovery

`src/routes.js` is the shared registry for route lookup, titles/descriptions, prerendering, canonical policy, indexability and sitemap membership. Page copy remains in `src/content.js`; there is no separate sitemap route list.

Every build writes `dist/sitemap.xml`, `dist/robots.txt`, and `dist/manifest.json`. Development serves the same artifacts from the same generator. `SITE_URL` is optional and defaults to the real production origin `https://callerwhale.com`; override it with an absolute HTTP(S) origin only. `SITE_INDEXABLE=false` makes every page noindex, emits an empty sitemap and sets robots to Disallow all for non-public builds. The client receives the same build policy as the HTML generator.

The sitemap advertises Home, Features, Pricing, Why Caller Whale, Security and Contact. Privacy/Terms remain public drafts with their own metadata/canonicals but are intentionally omitted from the sitemap until reviewed. Sign in, Sign up, Dashboard, Verification and 404 are noindex/nofollow, have no canonical or public structured data, and never enter the sitemap. Robots allows crawlers to read noindex on account-entry pages; it is not an authorization mechanism.

Each public page has its own title, description, canonical, Open Graph and Twitter tags; absolute social images and alt text; and Organization/WebSite/WebPage structured data with breadcrumbs where relevant. The schema contains no invented reviews, ratings, offers or product-readiness claims. Client navigation and history update this metadata as well. The browser manifest preserves the whale mark and uses display=browser; it makes no offline/installable-PWA claim. Existing nginx serves real 404 responses; local production preview now does too. No unrelated CSP/CAPTCHA changes are part of this polish.

## Motion and interaction

Workflow connectors animate in sequence using the existing icon family, not a simulated app screenshot. Horizontal on wide screens; vertical between stacked phone steps. The sequence pauses outside the viewport and when the tab is hidden. The visible workflow and footer share a persisted pause/resume control. System reduced motion always takes precedence. The initial client script applies saved motion preference before enabling entrances; missing storage remains supported.

Hero, page, section, menu and dialog entrances are finite and restrained. Links/arrows, navigation, presets, seat controls, fields, validation notices, busy buttons, FAQ expansion and chooser rows have consistent hover/focus/pressed/loading feedback where applicable. No layout-changing hover effects or moving photos behind active reading text. Keyboard focus remains visible; route changes without a fragment focus the main content. Missing observers and both reduced-motion modes keep all content readable. The genuine app screenshot count remains one.

## Verification and limits

`npm test` checks pricing, registry/metadata consistency, sitemap exclusions, site-origin validation, escaping, structured-data identity and non-indexable build policy. `npm run test:browser` covers responsive geometry, menus/dialogs, keyboard behavior, motion/reduced motion/pause persistence, metadata navigation/history, and discovery endpoints. Run `npm run build` to validate all raw public/account/404 HTML and the final artifacts.

Local verification is not proof of live indexing, rich-result eligibility, CAPTCHA settings, authenticated downloads, or deployment. Current production rollout still needs the configured deployment access and a live verification pass.
