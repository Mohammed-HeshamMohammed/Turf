# Not found

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: Any unknown URL.

## Job

Explain a missing page and offer a useful valid destination.

## Section plan

1. Plain missing-page heading.
2. Home and sign-in/dashboard links appropriate to known session state.
3. Optional support link without echoing sensitive query data.

## Actions and behavior

Primary: return to a safe known page. Preserve real HTTP 404; do not redirect every unknown URL to home.

## Layout and design

Use the relevant minimal shell with no repetitive promotional forms or fake search results.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; excluded from sitemap. Unknown admin-like URLs must not reveal staff page hints.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Check direct request, nested route, malformed query, trailing slash and client navigation. Raw HTTP and browser view agree; private route names are not suggested.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

A concise real 404 -> explanation -> Home and appropriate sign-in/dashboard path -> support if useful. No public search suggestions for staff paths.

### Copy and visual application

Match shared type/spacing, with minimal decoration. Avoid echoing the full unknown query or recovery token into visible text or analytics.

### Data and service boundary

Actual server status and frontend route resolution agree. Unknown nested routes must not be automatically served with a 200 marketing document or redirected home.

### Required edge states

Anonymous/signed-in, stale old path, malformed query, encoded path, deep refresh and client-side back navigation. Public not-found view must not leak whether an admin resource exists.

### Traceability

V01–V06, V19, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
