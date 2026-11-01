# Account

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /dashboard/account (proposed).

## Job

Let people understand and manage their supported personal/account settings.

## Section plan

1. Identity, email-verification and current account/workspace context.
2. Supported editable profile fields.
3. Explicit permission/access explanation.
4. Links to security and support; account closure only if a real approved flow exists.

## Actions and behavior

Primary: save supported changes with pending/saved/failed states. Email changes require a designed verification/re-auth flow before adding the control.

## Layout and design

Use a routed settings page. Dirty-form protection and clear cancel/revert actions; avoid multiple competing save buttons.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. Auth-owned identity writes go through auth; workspace/access changes through core API.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Test actual persistence after reload, concurrent changes, invalid values and authorization. Unsupported actions are not decorative buttons. Never show another workspace's cached profile.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Identity/email status -> product/workspace context -> supported editable settings -> change outcome -> security/help links. Separate customer entitlement fields from personal profile.

### Copy and visual application

Use a routed settings layout. Read-only unsupported fields should look read-only, not like editable controls with nonfunctional Save.

### Data and service boundary

Auth GET me/core account are existing reads; generic name/email/profile writes or account deletion must be confirmed/added explicitly. Email change requires fresh proof and a defined verification/linking policy.

### Required edge states

Dirty form, server validation, stale identity, cross-account cache, partial save, permission revoked and identity-provider mismatch. If account closure is later added, specify retention/recovery and do not implement a local-only illusion.

### Traceability

V06, V09, V17–V19, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
