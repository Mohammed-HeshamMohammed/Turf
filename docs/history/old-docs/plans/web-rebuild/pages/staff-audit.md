# Staff activity and audit

Status: Proposed staff-mode area; planning only. No public page/URL.
Parent: [Admin mode](admin-mode.md). Shared: [Journeys/permissions](../07-journeys-permissions.md).

## Job and layout

Explain who changed what and the authoritative outcome while keeping sensitive payloads out of operational views.

Read-only activity rows with actor, action, target, timestamp/timezone and safe summary; details reveal only allowed redacted fields. Filtering/paging/export need explicit support and counts must reflect scope.

## Actions and safeguards

Inspect/copy a safe reference; authorized export only after backend contract. Audit rows cannot be edited/deleted through ordinary UI. Distinguish action committed from email send failed and request denied from unknown result.

## Data and dependencies

Core /api/v1/platform/activity exists. Required additional events for elevation start/end/denial, sensitive auth operations and correlation are a backend gap if not present. Retention/storage protection is an operations policy, not a visual badge.

## Failure and recovery states

Empty versus no matches, unavailable history, partial older data and permission loss have honest states. No private request bodies, token URLs or setup secrets appear in filters or exports.

All actions require server-authorized staff scope and unexpired elevation. Preserve list context/focus on safe drawer close; no sensitive persistent client cache. Public navigation/search/sitemap never include this area.

## Acceptance

V25, V27 and V28; compare actual mutation transaction/event, redaction, timezone and search/export scope. Read-only UI alone does not establish tamper-proof storage.

Apply [component states](../09-components-interactions.md) and [verification matrix](../12-verification-matrix.md) in desktop/mobile light/dark.
