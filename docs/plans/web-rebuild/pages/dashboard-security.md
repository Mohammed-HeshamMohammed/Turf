# Account security

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /dashboard/security (proposed).

## Job

Manage second-step methods, sessions and device approvals with understandable consequences.

## Section plan

1. Verified sign-in methods and email status.
2. Authenticator setup/confirmation, device labels and three-device limit behavior.
3. Email/Telegram/desktop approval availability only when backed by real configuration.
4. Session list/revocation using the source-backed auth routes after payload/policy verification.
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

## Detailed implementation brief

### Layout and sequence

Sign-in methods -> verified email -> enroll/manage factors -> sessions -> pending desktop approvals -> recovery guidance. Separate enrollment wizard from challenge answering.

### Copy and visual application

Make device labels and expiry understandable; highlight consequence before fourth TOTP activation removes the oldest. Show setup QR/secret only during enrollment and exclude it from shared screenshots.

### Data and service boundary

Auth factors/setup/confirm/remove, sessions list/revoke and approvals routes exist in source. Trace current payloads/assurance; password change and factor removal use supported fresh-verification policy. Backup/recovery capability must be verified before presenting codes.

### Required edge states

Cancel enrollment, invalid/replayed code, expired challenge, fourth device, last-factor removal, current-session revocation, unconfigured mail/Telegram, lost desktop and denial/timeout. Email-only second-step methods cannot silently satisfy stronger admin policy.

### Traceability

J05; V10–V17, V22, V27, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
