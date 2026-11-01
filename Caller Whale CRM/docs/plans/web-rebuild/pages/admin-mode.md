# Admin mode inside the dashboard

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: Dashboard state; no /admin route.

## Job

Give authorized staff a temporary, auditable management area with private monitoring.

## Section plan

1. Enter admin mode control after role verification.
2. Fresh authentication/strong-factor ceremony for every new entry.
3. Active-mode indicator, remaining time and explicit Exit.
4. Staff management tools organized by authorized task.
5. Monitoring container inside the permitted area.
6. Audit/result feedback and expired/closed state.

## Actions and behavior

Scope actions by server role. Confirm consequential changes with target and effect. Use scoped elevation for management requests and monitoring; ordinary account tokens alone are insufficient for a new privileged session.

## Layout and design

Keep the useful staff rows and drawers where they work. Use search/filter/pagination and detail drawers to manage one person without losing list position. No admin discovery in customer search.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

No public route/sitemap/navigation/search entry. /admin returns 404. Private monitoring has no public hostname or port.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Server must expire idle/absolute sessions even with background refresh. Test re-entry, role removal, tab restore, multiple tabs, exit/logout, direct URLs and backend outage. See shared security plan for assurance gaps; UI hiding is not authorization.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
