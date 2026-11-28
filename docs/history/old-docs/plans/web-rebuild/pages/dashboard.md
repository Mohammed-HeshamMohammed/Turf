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

## Detailed implementation brief

### Layout and sequence

Shell -> access/verification task if needed -> period-bound usage summary -> supported desktop action -> activity preview -> security/approval links. Customers should not have to scroll past staff management or marketing.

### Copy and visual application

Heading welcomes the person without exposing email unnecessarily. Show exact task/action by state, including staff-only identity and dual customer/staff identity.

### Data and service boundary

Core GET account is the initial authority. Use can_download, not a frontend approximation. Auth approvals may load independently. No client-only admin state can authorize a privileged request.

### Required edge states

Public, unknown session, null access, unverified, active, zero remaining, suspended, staff-only, partial approvals failure, release unknown and account outage. Never render fake zeros or discard successful sections for unrelated widget failure.

### Traceability

J02, J06, J07; V06, V09, V17–V23, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
