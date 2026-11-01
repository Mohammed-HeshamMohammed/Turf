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
