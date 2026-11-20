# Private monitoring in admin mode

Status: Proposed staff-mode area; planning only. No public page/URL.
Parent: [Admin mode](admin-mode.md). Shared: [Journeys/permissions](../07-journeys-permissions.md).

## Job and layout

Show Grafana only during authorized staff mode without creating a standalone public monitoring product.

Contained monitoring view with loading/result/error state, clear Return/Exit controls and an accessible title. Do not duplicate Coolify terminal/database administration or expose connection credentials.

## Actions and safeguards

Open the existing private proxy session through the gateway's supported path after valid elevation. Expiry/logout/revocation closes the frame and invalidates the server session. Request polling/auto-refresh cannot count as meaningful human presence.

## Data and dependencies

Gateway /staff/monitoring with private proxy and core whoami checks is the existing integration concept. Verify cookie/path/frame/CSP rules and bind monitoring to scoped elevation. Existing example limits must be reconciled with the fresh-per-entry policy.

## Failure and recovery states

Frame blocked, no monitoring configured, denied, expired, network failure and proxy/core unavailable get specific safe explanations and a valid re-entry route. Never fall back to opening a public Grafana hostname.

All actions require server-authorized staff scope and unexpired elevation. Preserve list context/focus on safe drawer close; no sensitive persistent client cache. Public navigation/search/sitemap never include this area.

## Acceptance

V19, V22, V23, V26 and V29; direct-document access, absent/expired session, cross-origin framing, background refresh, multi-tab logout and private service network boundaries.

Apply [component states](../09-components-interactions.md) and [verification matrix](../12-verification-matrix.md) in desktop/mobile light/dark.
