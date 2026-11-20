# People and access review

Status: Proposed staff-mode area; planning only. No public page/URL.
Parent: [Admin mode](admin-mode.md). Shared: [Journeys/permissions](../07-journeys-permissions.md).

## Job and layout

Find a person, understand identity versus customer/staff access and perform only authorized access changes.

Table with supported identity/verification/access summary, selected detail and safe links to relevant invitation/workspace context. Clearly distinguish auth identity, product entitlement and platform role. Never show passwords, refresh tokens or factor seeds.

## Actions and safeguards

Access changes must describe which layer changes. Disabling a product user is not silently deleting Firebase identity, deleting records or removing staff status. Staff-related changes direct the owner to Staff management; avoid self-lockout and last-owner hazards.

## Data and dependencies

Core /api/v1/platform/people and per-id access route exist. Exact actor/target restrictions and identity/session revocation effects need source/staging confirmation; do not claim a global auth ban from a core-only disabled flag.

## Failure and recovery states

Duplicate/matching identities, no invitation, provider mismatch, role removed mid-view, conflict and dependency outage get distinct explanations. Private detail disappears on loss of permission.

All actions require server-authorized staff scope and unexpired elevation. Preserve list context/focus on safe drawer close; no sensitive persistent client cache. Public navigation/search/sitemap never include this area.

## Acceptance

V09, V17, V22–V25 and V28; validate same-email/provider edge cases and API authorization, with redacted diagnostics.

Apply [component states](../09-components-interactions.md) and [verification matrix](../12-verification-matrix.md) in desktop/mobile light/dark.
