# Downloads

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /dashboard/downloads (proposed).

## Job

Deliver the right supported installer and explain version/update status.

## Section plan

1. Supported platform and current verified release.
2. Version, release date, size and compatibility when available.
3. Authorized short-lived download action.
4. Release notes, installation help and update guidance.

## Actions and behavior

Primary: request download from core API. Show unavailable, preparing, expired-link and refused-access states. Do not invent mobile builds or browser deep links.

## Layout and design

Keep the next action clear and avoid exposing the raw private asset link. A failed release feed is not the same as no release exists.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. Private signed URLs never enter metadata, analytics or persistent browser storage.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Verify authorized asset download end-to-end, expiry, access revocation, release-feed failure and correct platform artifact. Distinguish desktop updater checks from website version display.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Platform/compatibility -> verified release details -> entitled download -> release notes/help -> update explanation. Unsupported OS/mobile stays clearly unavailable without a fake download button.

### Copy and visual application

Main action names the actual supported platform. Explain signing/update information only if verified through the release pipeline.

### Data and service boundary

GET account release/can_download, POST account/download and returned expiring asset. A null release conflates unknown/unavailable today; schedule explicit readiness contract if the UI distinguishes these.

### Required edge states

Entitlement denied, expired URL, feed unavailable, no release, wrong platform, revoked access after link creation and browser blocked download. Don't cache signed URLs or automatically request a new one in a loop.

### Traceability

J06; V17–V21, V28, V29. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
