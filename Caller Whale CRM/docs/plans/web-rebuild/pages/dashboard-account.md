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
