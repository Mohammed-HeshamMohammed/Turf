# Request password reset

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /forgot-password (proposed).

## Job

Start recovery safely without revealing whether the email belongs to an account.

## Section plan

1. Email input and short explanation.
2. Generic acknowledgement with a resend cooldown.
3. Return to sign-in and support path.

## Actions and behavior

Primary: send reset instructions. Response wording and observable behavior must avoid straightforward account enumeration.

## Layout and design

Single-task page; pending, success, offline, rate-limit and verification-required states. Preserve email on retry.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. Receiving auth endpoint owns rate limit and any human-check requirement.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Confirm actual mail delivery in staging, generic response for known/unknown addresses, retry cooldown and no token in logs. Route is added only after email-link contracts are traced.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
