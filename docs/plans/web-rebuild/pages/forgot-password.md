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

## Detailed implementation brief

### Layout and sequence

Email request -> generic acknowledgement -> cooldown/retry -> existing email link; include sign-in/support exits. Provider-only users get safe provider guidance without a revealing lookup.

### Copy and visual application

Headline proposal: 'Get back to your workspace.' The success copy is generic: if an eligible account exists, instructions are on their way.

### Data and service boundary

Auth POST password/forgot. Dedicated route is proposed; current sign-in reset action must still work or redirect deliberately. Endpoint abuse/human-check protection is a backend policy, not proof from a displayed widget.

### Required edge states

Known/unknown address, malformed input, provider-only identity, 429, unconfigured notification service, mail failure and offline. Do not disclose different outcomes to enumerate accounts.

### Traceability

J04; V07, V10–V13, V27, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
