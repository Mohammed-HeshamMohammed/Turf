# Account security

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /dashboard/security (proposed).

## Job

Manage second-step methods, sessions and device approvals with understandable consequences.

## Section plan

1. Verified sign-in methods and email status.
2. Authenticator setup/confirmation, device labels and three-device limit behavior.
3. Email/Telegram/desktop approval availability only when backed by real configuration.
4. Session list/revocation if supported by an API.
5. Pending device approvals with device/time/expiry and Approve/Deny.

## Actions and behavior

Require fresh verification for sensitive changes according to auth policy. Explain before enrolling a fourth authenticator that the oldest will be removed. Never show a setup secret again after enrollment.

## Layout and design

Show setup as a clear guided sequence and allow secure cancellation. Distinguish enrollment from factor proof. Desktop approval means the downloadable app; mobile remains future unless implemented.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. QR/setup secrets only in the active enrollment UI; no logging/analytics/screenshots with secrets.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Test enrollment, invalid/replayed code, cancel, fourth-device removal, revocation, approval deny/expiry and concurrent attempts. Prevent removing the last usable recovery method without a defined recovery policy.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
