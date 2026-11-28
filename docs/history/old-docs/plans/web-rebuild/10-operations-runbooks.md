# Environment, operations and failure runbooks

Status: Proposed checks/runbooks. No live changes authorized by this document alone.
Parent: [Master plan](README.md).

## Environments

Local uses non-production fixtures and test credentials. Staging has restricted access, noindex, isolated data/mail destinations/widget keys and explicit provider callback registration. Production has the canonical host, correct sitemap, real secrets entered securely and actual authorized delivery.

Never copy a production database or credentials into previews by default. Environment variables are validated at startup/build as appropriate; missing security requirements fail closed with redacted diagnostics. Use the existing annotated env catalog, and record presence/validity rather than values in audit reports.

## Host and service checklist

Canonical public website callerwhale.com; auth auth.callerwhale.com; gateway gate.callerwhale.com; landing submission API api.callerwhale.com. Verify current Coolify ownership/upstreams/DNS/TLS before release. Existing other service hostnames must be audited; this plan does not silently authorize domain deletion or expose internal containers.

Grafana/private proxy have no direct public hostname or published port; monitoring is only inside staff mode through the gateway path. Database/Redis traffic uses intended private networking/least privilege. Coolify environments are organizational labels, not proof that containers can reach each other.

Gateway must use correct route/core host, JWKS, trusted proxy chain and rate limits. Core/auth each keep exact origin/authorization rules. Do not treat a reachable /healthz as proof that sign-in, database, notifications or entitlement works.

## Runtime readiness

Record build commit/production snapshot, compatible config version, deployment status, container health, critical dependency checks and actual route results. Database schema setup uses the project's supported terminology/commands; do not reset or recreate production data to fix an unrelated UI issue.

Database backup/restore and persistent landing-store backup are separately tested before changes affecting storage. Monitor capacity, connection pools and failed writes. Account/source-of-truth separation remains intact; web rebuild is not a database consolidation project.

## Runbook O01: sign-in fails after provider return

Check callback target and code exchange without logging the code. Verify auth health/provider readiness, expiry/state and refresh coordination. Check browser preflight and actual account response at gateway/core, including allowed-origin error headers. Distinguish CORS, stale key, refused entitlement and network outage. Keep last known-good build/config available.

## O02: CAPTCHA prevents access

Check widget hostname/site key, server secret presence, action binding, Siteverify availability, CSP and browser blocking. Do not log/replay user tokens or silently bypass server enforcement. Show retry/support; any deliberate protection-policy change needs a separately reviewed operational action. A generated widget or saved key is not proof of live validation.

## O03: invitation/contact/security email missing

Determine stored vs queued vs accepted by mail service vs received. Check authorized service request, queue/error record, sender mailbox, delivery diagnostics and recipient route. Do not resend unboundedly or rotate credentials blindly. Invitation database state can remain valid even when sending fails; use controlled resend with clear result.

## O04: download/update unavailable

Check entitlement, release feed/token permissions, artifact platform/version and expiring link route. A feed outage must not be confused with a new customer lacking permission. Installer signature/updater-feed verification belongs to the desktop release path; website version display is not proof of update installation.

## O05: privileged access incident

End affected elevation, revoke sessions/roles as appropriate through authorized operations, preserve redacted audit evidence and verify private monitoring enforcement. Hiding the navigation alone does not fix a backend authorization failure. Report scope and rollback compatibility before resuming staff functions.

## O06: wrong indexing or broken route

Check actual HTTP status, initial HTML/headers, canonical, robots and sitemap on correct host. Remove private content exposure at the server. Search removal tooling is supplementary and does not secure leaked data. Never add robots Disallow as a substitute for authentication or remove noindex merely to hide an error.

## Telemetry plan

Collect aggregate route/API failure rates and safe event categories: auth start/result, refresh refusal, preflight failure, human-verification failure class, invitation delivery status, download failure and staff expiry/denial. Never log credentials, callback/reset/download URLs, CAPTCHA proofs or full private payloads.

Include safe request ids for support. Define destination/retention/access before enabling telemetry; no account-page replay by default. Development fixtures never become invented production KPI displays.

## Rollback and post-release

Capture previous compatible snapshot/config; deploy only affected production branches after required checks. Stop/roll back on auth breakage, privilege exposure, wrong indexing or widespread route failures. Frontend rollback cannot undo incompatible database/API behavior; define backward compatibility first.

Post-release checks include anonymous reading/forms, real staged-then-production account journey as authorized, exact preflight, invalid-token refusal, private-route refusal, recovery mail links, download entitlement and admin expiry. Record verified/partial/blocked evidence, not just “deploy succeeded.”
