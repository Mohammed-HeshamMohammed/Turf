# Implementation sequence and acceptance evidence

Status: Proposed. Parent: [Web rebuild plan](README.md).

## Stages and reviewable outputs

| Stage | Output | Exit check |
| --- | --- | --- |
| 0 — Audit | Every section's keep/improve/remake record, route/data inventory, asset list | Owner can identify what changes and why |
| 1 — Design | Home + dashboard compositions in two themes and desktop/mobile | Select direction and validate hierarchy before propagating |
| 2 — Foundation | Tokens, components, layouts, one route registry | Keyboard/responsive checks; metadata and layout agree |
| 3 — Public site | All public page plans implemented, genuine content/screens | Direct-route, no-JS content, discovery and form checks |
| 4 — Identity | Signin/signup/verify/recovery and required human checks | Real staging provider and email flows pass |
| 5 — Account dashboard | Overview, usage, downloads, account and security | Authorized API contracts and access states pass |
| 6 — Staff | Fresh elevation, management, audit, private monitoring | Direct-access, inactivity, expiry, revocation checks pass |
| 7 — Release | Approved production branch snapshots and deployment evidence | Production smoke tests; rollback ready |

## Required configuration map

Inspect values securely and record only presence/validity, never secrets, in audit artifacts.

| Component | Check |
| --- | --- |
| Landing web build | SITE_URL, VITE_CALLERWHALE_API_URL, VITE_CALLERWHALE_LANDING_API_URL match intended hosts |
| Landing web runtime | AUTH_ORIGIN, API_ORIGIN, LANDING_API_ORIGIN, GRAFANA_ORIGIN align with generated URLs and CSP |
| Auth | Public/callback/landing URLs, origin allowlist, signup policy, dev tokens off, provider readiness, notification delivery, Turnstile configuration |
| Gateway | Host mappings, CORE_HOST, JWKS, private monitoring upstream, proxy hops, rate limits, preflight regression |
| Core API | Auth key source, origin allowlist, private DB connection, staff/elevation policy, account/download authorization |
| Notifications | Auth/core service authorization, sender/domain and delivery checks; no SMTP credentials in web builds |
| Monitoring | Private network/no public hostname or port, root subpath, private proxy session settings |
| DNS/TLS | Canonical host, www redirect, auth/API/gateway host ownership and certificates |

Do not infer live readiness from example files. Record any stale/unused variables and a separate proposed removal; do not delete production configuration as part of documentation.

## Quality targets

Targets are acceptance goals, not current measured results.

- Accessibility: WCAG 2.2 AA review of forms/navigation/focus/status, keyboard-only completion, reduced motion, both themes and 200% zoom.
- Performance: target public LCP <=2.5s, INP <=200ms and CLS <=0.1 at the 75th percentile when sufficient field data exists. Before field data, record representative mobile lab measurements with conditions; do not call them field results.
- Bundle behavior: public navigation does not load dashboard tables, staff monitoring, session-management UI or CAPTCHA before needed. Set bundle budgets from the audited baseline rather than inventing an arbitrary KB target.
- Reliability: cancel stale requests, deduplicate session operations, cap retries and keep user input during recoverable errors. No invented zero values when data fails.
- Privacy: no credentials or private account data in built HTML, public assets, source maps, sitemaps, analytics or exported screenshots.

## Acceptance matrix

Test public visitor, uninvited signed-in person, unverified invitee, active customer, exhausted limit, suspended customer, staff member and revoked staff member. Combine with loading, empty, permission failure, 401 refresh, 403, 429, offline and server error.

Critical journeys:
1. Search result -> public page -> relevant CTA -> account/invitation flow.
2. Email/password and Google/Apple -> correct local return -> dashboard.
3. Confirmation/reset email -> valid/expired/used link -> clear result.
4. Account -> usage filter -> authorized download -> desktop sign-in.
5. Customer tries staff path/API -> refusal.
6. Staff -> fresh elevation -> action/monitoring -> exit/idle/absolute expiry -> new verification.
7. Theme/mobile/keyboard flow without hidden or overlapping controls.

Check deep links, reload/back/forward, www, trailing slash, unknown route, query stripping, CORS preflight plus actual response, CSP and asset caching. Use integration tests for auth boundaries and failures, not tests that merely copy component markup.

## Release and rollback

Plan work lands on main per repository workflow; runtime releases happen only during the later implementation task. Refresh only affected production branches using tools/publish-production.mjs. Build in staging with separate data and widget credentials; record branch/commit, configuration validation, health and journey evidence.

Before deployment capture the previous known-good snapshot and its compatible configuration. Roll back on broken sign-in, privilege exposure, missing noindex, widespread route failures or material regressions. A frontend rollback cannot automatically undo incompatible API/database changes; specify compatibility before shipping them.

After release verify the actual public endpoints and representative browser journeys, then submit the sitemap. Monitor auth exchanges, refresh failures, gateway preflights, 4xx/5xx rates, verification failures, downloads and CSP violations with sensitive values redacted. Distinguish verified, partial and blocked results.

## Primary references

- [W3C: WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C: minimum target size and exceptions](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum/)
- [web.dev: Core Web Vitals thresholds and field measurement](https://web.dev/articles/vitals)
