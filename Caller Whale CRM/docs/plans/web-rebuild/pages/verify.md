# Confirm email

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /verify.

## Job

Complete email ownership proof with a clear result and next step.

## Section plan

1. Minimal account shell and validating state.
2. Success, already handled, invalid, expired and incomplete-link states.
3. Appropriate dashboard/sign-in link and resend path.

## Actions and behavior

Consume the actual auth-issued token once. Remove it from history after capture; deduplicate development/re-render attempts. Refresh account claims only after successful verification.

## Layout and design

Avoid a spinner with no explanation or timeout path. Resending follows cooldown without exposing account existence.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap; no-store and restrictive referrer policy for token-bearing documents.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Use real staging email links and test missing, expired, replayed and wrong token; reload/back must not accidentally produce misleading success or repeat changes.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
