# Platform staff management

Status: Proposed staff-mode area; planning only. No public page/URL.
Parent: [Admin mode](admin-mode.md). Shared: [Journeys/permissions](../07-journeys-permissions.md).

## Job and layout

Let the platform owner manage administrators with explicit privileges and fresh verification.

Current owner/admin roster, role explanation, selected staff detail and change history where supported. Explain platform owner versus customer workspace owner. Owner bootstrap is a server operation, not public self-registration.

## Actions and safeguards

Only an elevated platform owner can name/remove platform admins. Confirm exact person/role/effect and require appropriate fresh proof. An admin cannot promote themselves. Keep recoverable owner access; no owner deletion/demotion control inferred from generic staff endpoints.

## Data and dependencies

Core /api/v1/platform/staff GET/POST exists; owner-only checks must be tested. Session/elevation invalidation for removed staff is a required integration contract, not just removing a row from the UI.

## Failure and recovery states

Non-owner read/deny according to endpoint policy, unknown person, stale role, attempted self-promotion, owner safety restriction and revoked actor must be covered. No automatic retry of a privilege change.

All actions require server-authorized staff scope and unexpired elevation. Preserve list context/focus on safe drawer close; no sensitive persistent client cache. Public navigation/search/sitemap never include this area.

## Acceptance

V22–V25 and V28; exercise direct API attempts by admin/customer, existing elevated sessions after removal, correct target confirmation and immutable audit semantics as implemented.

Apply [component states](../09-components-interactions.md) and [verification matrix](../12-verification-matrix.md) in desktop/mobile light/dark.
