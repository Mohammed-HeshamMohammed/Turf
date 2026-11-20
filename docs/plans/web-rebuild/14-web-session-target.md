# Recommended web-session target and transition

Status: **Architecture proposal, not approved or implemented behavior.**
Parent: [Master plan](README.md). Decision: D04 in [decision register](11-work-breakdown-decisions.md).

## Recommendation and trade-off

Evaluate a thin same-origin web-session adapter as the preferred security target: the browser holds an opaque session cookie; the adapter keeps central-auth access/refresh tokens server-side and calls authorized APIs. React/Vite continues rendering the website. Auth remains the only identity/Firebase broker; the adapter is not a second password database/provider.

This reduces token exposure to browser JavaScript but adds a service/state store, CSRF defenses, rotation, failure modes and operational ownership. It does not make XSS harmless. Compare costs against the current bearer model and record D04 before implementing the change. Do not add it incidentally while styling forms.

If the current bearer client is retained initially, document browser-refresh-storage/XSS exposure, token lifetime/rotation/revocation and mitigations. Do not claim HttpOnly protection while a browser-readable refresh credential remains.

## Proposed boundaries

Browser -> same-origin adapter -> central auth/core API. Provider proof still follows central-auth policy. The adapter exchanges a one-time result through a supported server flow and issues an opaque web cookie. No Firebase SDK, signing key or refresh token enters built JavaScript.

Store only needed credential/session linkage with secure storage, expiry and revocation. Persistence/encryption/backup ownership is an implementation decision. Do not reuse the public landing store or give web containers direct auth-database access by convenience.

A path such as /web-session/* is illustrative, not an existing endpoint. Define bootstrap, login/provider-start/exchange, challenge, logout/refresh and authorized forwarding contracts before changing browser API URLs. No arbitrary upstream URL forwarding.

## Cookies and CSRF

Propose Secure, HttpOnly, host-only cookies with Path=/ and a __Host- prefix where compatible. SameSite=Lax is a starting policy to test against provider callbacks and app handoffs. Avoid parent-domain cookie sharing. Session/account responses are no-store.

State-changing operations need reviewed CSRF defenses, including exact Origin checks and a session-bound token/header as appropriate. SameSite alone is not the complete defense. GET cannot perform password/staff mutations or logout side effects. Intentional desktop/direct API clients keep their own explicit authentication contracts.

## Lifecycle

1. Public reading does not require an account session.
2. Successful proof creates/rotates the web session to prevent fixation.
3. Refresh is single-flight per session with atomic rotation and safe concurrent-tab behavior.
4. Server-defined idle/absolute expiry is distinct from staff elevation. Ordinary refresh cannot elevate.
5. Logout/revocation destroys server credentials/session, expires the cookie, clears private caches and signals relevant tabs.
6. Session-store/auth outage fails closed for private operations while public content remains available.
7. Destination services still check role/entitlement; a stale adapter snapshot cannot override suspension.

Elevation is separately scoped and linked to the current session/fresh ceremony. It cannot travel through URLs or be reused across another session. Monitoring follows the authoritative lifecycle rather than an independent browser timer.

## Transition

Desktop keeps its central-auth native flow; a web cookie does not replace native credential storage. Preserve actual email/provider destinations or introduce tested compatibility. Do not leave the old web path able to bypass stronger policy.

Deploy compatible adapter/backend contracts before switching frontend; stage isolated accounts first; specify rollback for both session types. Clean up old browser refresh credentials only after a successful transition, with no plaintext proofs in diagnostic logs.

## Decision gate and verification

Require threat review, service/state/secret ownership, CSRF/cookie tests, callback/desktop compatibility, concurrency/load and rollback evidence. Extend V08–V19/V22–V23/V28–V29 for fixation, rotation races, malicious cross-site writes, denied origins, revoked users and session-store outage.

Design review may proceed before D04; the production account release cannot ignore the decision. This document changes no service, host or config.

## Primary references

- [OWASP: Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP: CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
