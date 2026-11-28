# Sign up

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /signup.

## Job

Create an account under the chosen access policy with clear password and verification guidance.

## Section plan

1. Invitation/public-registration explanation from policy.
2. Supported name/email fields and password.
3. Live password checklist from auth policy, optional confirm-password local check.
4. Conditional human verification and configured provider signup.
5. Relevant policy links and confirmation next step.

## Actions and behavior

Primary: create account when permitted; otherwise explain/request invitation. A new identity does not automatically grant a workspace or staff access.

## Layout and design

Show requirements before failure; show field-level guidance and preserve non-sensitive inputs. Do not collect age without an approved purpose. Warn clearly before leaving an incomplete form only where useful.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. Signup policy and human verification are independent server controls.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Test invitation matching, uninvited signup policy, malformed/duplicate email, all password rules, missing/replayed CAPTCHA, provider signup and email delivery. No dev token exposure.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Invitation/access explanation -> supported provider or email/password -> minimal profile -> email ownership step -> core entitlement check -> dashboard/access state. Keep an already registered person a clear route to sign in.

### Copy and visual application

Headline proposal: 'Get your workspace started.' Display password checklist before submit. A confirm field is local only; unsupported username/age fields are not silently stored in identity.

### Data and service boundary

POST auth accounts/OAuth, email verify/resend, then core account activation. Source invitation behavior is email-bound; do not mint fictitious invitation proofs or expose invitation details to an unverified caller.

### Required edge states

Invitation-only refusal, wrong invited email/provider, duplicate identity, existing account, partial identity-created/email-failed, expired proof, validation and CAPTCHA replay. Never create a second account as a retry shortcut.

### Traceability

J03; V09–V15, V18, V27, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
