# Identity, human verification and privacy

Status: Proposed. Parent: [Web rebuild plan](README.md).
Current implementation reference: [bot protection](../bot-protection.md).

## Service responsibilities

The public site serves content. Auth owns identities, provider sign-in, password policy, second steps and session issuance; Firebase credentials remain there. Gateway verifies token policy and forwards valid browser preflights to backend CORS checks. Core API owns account/workspace authorization and staff permissions. Notifications delivers messages on authorized service requests. Grafana remains a private service reached through an authorized dashboard session.

Keep these responsibilities even if the frontend is reorganized. Browser configuration contains public URLs and a Turnstile site key, never service credentials, signing keys, SMTP passwords or the Turnstile secret.

## Session and redirect contract

Public pages remain readable without auth/API availability. Private routes wait for session resolution without flashing account data, then show the appropriate access state. Preserve an allowlisted local next destination; reject external URLs, protocol-relative values and encoded bypasses. After provider return, exchange a single-use code and remove it from the address immediately; never store or log callback tokens.

Deduplicate callback exchange and refresh operations. One expired access token may trigger one refresh/retry; do not loop. A network failure must not be reported as a wrong password or suspension. Logout clears account caches and closes admin mode across relevant tabs.

Before implementation, compare the current browser refresh-token storage with a same-origin HttpOnly session adapter. The latter needs CSRF protection, cookie scope, rotation and service/deployment ownership. Document the choice; neither approach is approved merely by this plan.

Preferred target and transition trade-offs are detailed in [web-session proposal](14-web-session-target.md). Keep this decision separate from visual implementation and preserve native-app compatibility.

## Signup and recovery

Read password rules from auth and enforce them on the server: current contract is 8–4096 characters with uppercase, lowercase, number and special character. Provide matching guidance before submission. Name/email belong to supported account fields. Confirm password is local validation only. Do not collect age/date of birth without a defined product/legal requirement and retention purpose.

AUTH_PUBLIC_SIGNUP controls registration access; it does not control CAPTCHA. Baseline stays invitation-only until explicitly changed. AUTH_DEV_TOKENS stays false in production.

Recovery responses do not reveal whether an account exists. Tokens expire, are single-use and are scrubbed from history/referrers/telemetry. Trace existing email-link URLs before choosing new pages; preserve already issued links when practical.

## Human verification

Cloudflare Turnstile Managed mode is the proposed provider, reusing the current auth integration. No CAPTCHA on ordinary reading/navigation. When bot protection is enabled, password signup/signin and OAuth starts require a valid token on the server; direct endpoint/provider-start URLs cannot bypass it.

Auth fetches public security configuration for the frontend and calls Siteverify itself. Check success, expected action and hostname. Tokens expire after five minutes and are single-use: reset after submission, expiration or challenge error. Never cache a successful token for reuse.

Specify pending, interaction required, verified, expired, blocked script, offline and verification-service timeout states. Preserve entered form fields during retry and provide a clear recovery action. A client script failure never silently disables a server-required check.

Contact/waitlist abuse protection belongs to their receiving service. Plan rate limits, input limits, honeypot and Turnstile verification there if enabled; do not forward an auth token or assume auth's CAPTCHA protects unrelated forms. Forgot-password/resend protection requires an explicit endpoint policy and test; current signup/signin coverage is not proof of those flows.

Launch gate: real widget hostname/site key, secret entered directly in auth, server enforcement, CSP script/frame/connect allowances, valid/expired/replayed/wrong-host/wrong-action tests, then enable the flag. Test keys are for non-production only.

## Staff mode and monitoring

Require staff permission from the server and fresh authentication on every entry. Record the elevation server-side with scoped capability, issue time, absolute expiry and last accepted user activity. Returning after exit/expiry requires a new ceremony; ordinary session refresh cannot recreate elevation.

Proposed staff policy: an authenticator or equivalent strong factor; email verification alone must not silently become the strongest admin permission. Confirm claim method/assurance support before changing enforcement.

Use explicit Enter/Exit controls and show remaining elevated time. Server enforces both idle and absolute limits; background polling and Grafana auto-refresh must not count as meaningful user presence. Reconnection, tab restore, logout, role revocation and backend failure must fail closed. Client timers improve UX but are not the authority.

Grafana has no public hostname/published port. The gateway path does not bypass the private proxy's role/session checks. Direct navigation, expired cookies and cross-origin framing must be tested. Hide admin actions from customer UI/search while recognizing that hiding code is not a security boundary.

## Headers, CORS, caching and logging

Keep CSP restrictive; permit only required script/frame/connect/form destinations. Inventory Cloudflare-injected scripts and analytics separately rather than add unsafe-inline to silence warnings. Prefer eliminating unnecessary injection; permit intended scripts with reviewed origins or supported hashes/nonces.

Allow exact deployed origins in auth/core/landing APIs. Check OPTIONS plus actual success/error responses. Gateway-generated 401/403/429 must have a deliberate CORS response strategy for allowed callers, so clients can interpret auth/rate-limit errors without broad origin reflection.

Account responses and token-bearing documents use no-store. Hashed public assets may be immutable; documents revalidate. Redact passwords, authorization headers, email-link codes, query tokens and human tokens from logs/telemetry. Avoid replay/analytics capture on account and recovery pages. Validate consent and retention before adding tracking.

## Acceptance

Exercise valid/expired/revoked sessions, unknown account, pending invitation, suspended access, wrong provider account, callback replay, MFA denial/timeout, logout in another tab and failed API dependencies. Verify server refusals independently of the hidden UI. Record actual live checks separately from mocks.

## Primary references

- [Cloudflare: server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare: Turnstile CSP](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
