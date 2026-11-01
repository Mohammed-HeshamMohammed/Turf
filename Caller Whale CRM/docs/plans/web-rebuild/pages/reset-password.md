# Choose a new password

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /reset-password (proposed; validate email contract).

## Job

Use a recovery link to choose a compliant password and explain the resulting session changes.

## Section plan

1. Link validation state without exposing the token.
2. Password rules/reveal and local confirm field.
3. Save result with sign-in next step.
4. Invalid/expired/used link route back to recovery.

## Actions and behavior

Primary: set password once. Server validates policy and invalidates sessions according to auth's contract. Do not automatically imply provider-only accounts have a local password.

## Layout and design

Keep token hidden and scrubbed after capture. Retain user-entered password only as needed in memory during a recoverable in-page failure; never persist it.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap; no-store and restrictive referrer policy.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Test policy mismatch, link expiry/replay, double submit and revoked existing sessions. Confirm issued links reach this route or a tested compatibility adapter.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
