# Verification matrix and release evidence

Status: Proposed test plan. Parent: [Master plan](README.md).
Existing [delivery plan](04-delivery.md) remains the release sequence.

## Test layers

Source/contract tests verify policy and response shapes. Component checks verify states/focus. Integration tests cross real app/gateway/auth/core boundaries. Staging browser tests use isolated accounts/mail/widget settings. Production checks are a small authorized smoke set, not destructive fixture seeding.

Use mocks to exercise outages and unusual states, labeling them as mock evidence. Do not claim mocked calling/email/provider screens as live behavior.

## Required checks

| ID | Scenario | Required result/evidence |
| --- | --- | --- |
| V01 | All current/proposed page deep links | Correct status, raw content, layout/title, reload/back/forward |
| V02 | www/slash/unknown/admin-like path | Intended single redirect or 404; no private hint |
| V03 | Sitemap/robots/meta/header parity | Canonical eligible 200 URLs only; private noindex; staging blocked |
| V04 | Public site with auth/core down or JS off | Useful prerendered reading/navigation; clear form limitation |
| V05 | Hero/lower-page image/font failures | No unreadable headline/layout shift; fallback content usable |
| V06 | Mobile/themes/keyboard/zoom/reduced motion | Full-page evidence, no overlap/hidden tasks, restored focus |
| V07 | Waitlist/contact success/duplicate/429/offline/5xx | Honest receipt, preserved text, no fake mail success |
| V08 | Signin email/provider + safe next | One exchange and account load, correct local return |
| V09 | Wrong account/uninvited/unverified/suspended | Correct next action; no entitlement inferred from identity |
| V10 | Callback/reset token replay/expiry | Server refuses; token scrubbed from URL and diagnostics |
| V11 | Password requirements/frontend vs auth | Same policy; malformed/Unicode/length edges tested |
| V12 | Turnstile absent/expired/replayed/wrong action/host | Server refuses when enabled; disabled policy correctly reflected |
| V13 | Direct OAuth start bypass attempt | Protection cannot be bypassed by URL/method variants |
| V14 | Second-step deny/expiry/method switch/resend | Bound server challenge, cooldown, no polling leak |
| V15 | Three authenticators then fourth/cancel/remove | Stated oldest-device behavior; no unintended removal on cancel |
| V16 | Desktop approval | Correct requesting attempt/device; single-use approve/deny/expiry |
| V17 | Expired access/refresh concurrency/revoke/logout | Bounded coordinated retry; cache/elevation cleared |
| V18 | Browser account preflight AND actual response | Correct allowlisted origin on success and readable allowed-origin errors |
| V19 | Disallowed origin/forged token/private path | No authorized data; gateway and destination checks remain |
| V20 | Usage zero/unknown/limit/period rollover/timezone | Honest values and UTC period semantics; readable chart alternative |
| V21 | Download entitled/refused/expired/release unavailable | Correct artifact and no private URL caching/telemetry |
| V22 | Staff entry/re-entry/idle/absolute expiry | Fresh proof each entry, server cutoff despite background polling |
| V23 | Staff role removal/customer guessing endpoints | Immediate refusal at authoritative boundary; no UI-only guard |
| V24 | Owner vs admin; self/staff target restrictions | Owner-only changes refused to admin, clear role-aware UI |
| V25 | Staff mutation conflict/uncertain response | Reconcile, no blind duplicate write; audit entry |
| V26 | Grafana direct origin/path/iframe/expired session | No public standalone access; authorized embedded state only |
| V27 | Mail verification/invitation/reset delivery | Real send/receive/link results with redacted evidence |
| V28 | Build artifacts/source maps/logs/analytics | No secrets, private records or token-bearing URLs |
| V29 | Health/dependency/rollback | Correct commit/config, functional journeys, compatible rollback |
| V30 | Whole content/readiness audit | No invented metrics, final policies without review, unbuilt feature promises |

## Evidence format

Record id, environment/host, build commit, actor role/account fixture, device/browser/viewport/theme, preconditions, steps, expected/actual, safe screenshot/log reference, result (pass/fail/blocked/not run), owner and date. Redact credentials, token URLs, TOTP seeds/QR, private people and internal diagnostics before sharing.

For V06 capture each page's full layout and important expanded/error states at chosen phone/tablet/desktop sizes in both themes. A single hero screenshot cannot satisfy the page.

## Coverage rules

Every page plan links acceptance IDs. Every privileged mutation gets server permission, expiry, target restriction, conflict and audit checks. Every new backend contract adds integration coverage. Repeat only checks affected by a later change or a required release gate.

No new behavioral tests are needed for documentation edits. During implementation use tests that exercise real boundaries; avoid brittle screenshot-text duplication or tests that only mirror markup.

## Release stop conditions

Any private data leak, privilege bypass, recovery/verification bypass, broken normal sign-in, incorrect production noindex/canonical policy or unexplained contract mismatch stops the relevant release. Cosmetic issues are triaged by usability impact; do not hide a failed security gate behind a high visual score.

Production readiness is recorded per component/journey. “Main pushed,” “CI green” and “Coolify healthy” are useful evidence, each insufficient on its own to declare the whole product complete.
