# Invitations and customer access

Status: Proposed staff-mode area; planning only. No public page/URL.
Parent: [Admin mode](admin-mode.md). Shared: [Journeys/permissions](../07-journeys-permissions.md).

## Job and layout

List pending/active/suspended invitations and manage one person's product access without confusing a saved record with email delivery.

Table: invited email/name, status, monthly limit, used this period, last use and delivery state. Filters/search/page state need actual backend contracts; current source list is bounded to 1000. Keep selected row/context while a detail drawer opens.

## Actions and safeguards

Invite requires email and monthly limit, optional supported name/note. Show created-but-not-emailed separately. Resend is explicit and controlled. Limit edits show current/new value and period effect. Suspend/reactivate/withdraw use the actual valid transition; pending cannot be forced active. Do not suspend yourself or staff through a customer-access action.

## Data and dependencies

Core /api/v1/platform/invitations, per-id PATCH/DELETE, resend and usage routes exist in source. Pagination, optimistic version checks and result reconciliation beyond current responses are backend dependencies.

## Failure and recovery states

Empty, mail unavailable, duplicate email, bad limit, actor expired, target changed, create succeeded/mail failed and uncertain mutation are separate states. Preserve safe draft on recoverable errors; never persist private notes in public browser storage.

All actions require server-authorized staff scope and unexpired elevation. Preserve list context/focus on safe drawer close; no sensitive persistent client cache. Public navigation/search/sitemap never include this area.

## Acceptance

V22–V25, V27 and V28; prove role/target/expiry refusal at API and exactly one audited mutation. Test resend without duplicate invitation creation.

Apply [component states](../09-components-interactions.md) and [verification matrix](../12-verification-matrix.md) in desktop/mobile light/dark.
