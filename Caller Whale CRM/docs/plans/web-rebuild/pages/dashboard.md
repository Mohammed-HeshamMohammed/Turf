# Dashboard overview

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /dashboard.

## Job

Show account access, the next useful task and a truthful summary.

## Section plan

1. Stable dashboard navigation and account context.
2. Actionable access state: uninvited, unverified, active, suspended or exhausted.
3. Credit/usage overview with period and accessible text.
4. Desktop availability and download/open action where supported.
5. Recent activity preview and links to focused pages.
6. Pending device approvals; staff entry only when authorized.

## Actions and behavior

Primary varies by state: confirm email, download app, review usage or contact support. Do not show equal-priority cards for every possible task.

## Layout and design

Keep useful existing account information; move long usage and security sections to child pages. No fabricated zeros while loading. Mobile reads in action-first order.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. All account data authorized through core API; neutral static shell only.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Verify every access state and role, staff-only account, customer+staff account, loading/empty/errors, period rollover, theme and mobile. Refresh/deep links must resolve without flashing restricted content.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
