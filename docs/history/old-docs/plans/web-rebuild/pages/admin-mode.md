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

## Detailed implementation brief

Individual areas: [invitations](staff-invitations.md), [workspaces](staff-workspaces.md), [people](staff-people.md), [staff roles](staff-roles.md), [audit](staff-audit.md) and [private monitoring](staff-monitoring.md). These are mode states, not public /admin routes.

### Layout and sequence

Staff entry control -> fresh ceremony -> explicit active-mode indicator and timer -> six task areas -> exit/expired view. Keep task selection local to this mode rather than publish a new /admin route.

### Copy and visual application

Preserve useful existing people rows/detail drawers. Separate customer versus elevated navigation; show exact target/effect before a management change. No giant marketing image in operational controls.

### Data and service boundary

Existing core platform role checks and proxy sessions are references. Server-scoped elevation across ALL privileged management requests is a required backend integration; existing mfa boolean/client timer is not proof it is implemented.

### Required edge states

Fresh-entry refusal, insufficient assurance, idle and absolute expiry, background polling, tab restore, role removed, current operation uncertain and proxy/core outage. Clear data on authoritative exit and require fresh proof for re-entry.

### Traceability

J07; V19, V22–V26, V28, V29. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
