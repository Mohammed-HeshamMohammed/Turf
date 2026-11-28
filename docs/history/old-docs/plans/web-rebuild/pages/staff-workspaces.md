# Workspace management

Status: Proposed staff-mode area; planning only. No public page/URL.
Parent: [Admin mode](admin-mode.md). Shared: [Journeys/permissions](../07-journeys-permissions.md).

## Job and layout

Review customer workspace/access summaries and perform authorized account-management actions without browsing arbitrary CRM records.

Filterable list and selected workspace detail: identity, owner contact as authorized, suspension, plan/status/period and server usage units. Keep actual credit data distinct from legacy minute/subscription fields. Totals describe only the returned scope.

## Actions and safeguards

Authorized suspension and owner-restricted plan/unlimited changes use a clear target/effect confirmation and reason/audit where supported. Do not make read-only payment records look like functioning billing/refunds. No customer-record impersonation button without a separately approved audited policy.

## Data and dependencies

Core /api/v1/platform/organizations and per-id suspend/subscription plus related platform routes exist. Document exact methods/payload/owner rules from source before UI. Search/pagination/export/versioning may need backend work.

## Failure and recovery states

Empty, partial summary, unsupported legacy billing fields, permission denied, stale target and pending/unknown write must be represented. Refresh target after a mutation rather than update every summary from an assumption.

All actions require server-authorized staff scope and unexpired elevation. Preserve list context/focus on safe drawer close; no sensitive persistent client cache. Public navigation/search/sitemap never include this area.

## Acceptance

V20, V22–V25 and V28; verify role scopes, changed target, monetary units/periods and audit. A platform overview does not grant access to CRM data.

Apply [component states](../09-components-interactions.md) and [verification matrix](../12-verification-matrix.md) in desktop/mobile light/dark.
