# Privacy

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /privacy.

## Job

Explain what data is collected, why, where it goes and how to exercise privacy choices.

## Section plan

1. Responsible business and effective date.
2. Account, contact, product and security data categories.
3. Purposes, service providers, retention and deletion.
4. Cookies/analytics and choices.
5. Contact and revision history.

## Actions and behavior

Policy links work without account access. Contact/privacy requests use a genuine supported channel.

## Layout and design

Comfortable reading width with section anchors. Keep promotional CTAs out. Legal review is an owner responsibility, and source facts must be supplied before publication.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Public/indexable; include in sitemap once substantive/current. No policy placeholders presented as final.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Review against actual auth, notification, hosting and analytics choices. Retention numbers are explicit approved values, not invented defaults. Test print and mobile reading.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Readable summary -> responsible business/date -> data categories/purposes -> processors/transfers -> retention/choices/deletion -> cookies -> contact -> version history. Use section links and a print-friendly view.

### Copy and visual application

Use plain specific language matching the chosen services and actual controls. A plan marked 'requires legal review' must not be shipped as a final policy without business approval.

### Data and service boundary

Content owner supplies actual responsible entity, jurisdiction/contact, processors, purposes and retention. Do not copy current example mail addresses or invent retention periods.

### Required edge states

Long legal text, print, zoom, link changes and consent-policy mismatch. Policy remains accessible without signing in or loading optional tracking.

### Traceability

V01–V06, V28, V30. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
