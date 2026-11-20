# Contact

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /contact.

## Job

Route a visitor's request to an accountable recipient and acknowledge it accurately.

## Section plan

1. Reason for contacting and appropriate support information.
2. Minimal form: name, reply email, category and message.
3. Privacy explanation and success/reference state.
4. Alternative contact route when submission fails.

## Actions and behavior

Primary: send once. Server validates length/format, rate limits and records acceptance. Claim email delivery only after verified delivery.

## Layout and design

Single-column labeled fields; preserve text on timeout and prevent accidental duplicates. A successful stored request is described as received, not necessarily emailed.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Public/indexable and sitemap. Human verification is conditional on the receiving API's own enforcement, not the auth widget.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Test invalid input, duplicate click, slow/offline API, 429 and service error. Verify storage and expected notification paths separately. Never display a generic success on failure.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Reason/category -> minimal fields -> relevant privacy note -> submit -> actual acknowledgement. Show alternative contact information only when owned and checked. No redundant waitlist form appended.

### Copy and visual application

Headline proposal: 'Tell us what you need.' Distinguish a product/access enquiry from support or security reporting.

### Data and service boundary

Landing POST /contact currently validates/stores a message and returns ok. Reference identifiers, categories beyond supported fields, file upload and actual notification delivery require contract work. Do not add unsupported attachments.

### Required edge states

Invalid/oversized input, honeypot, duplicate click, uncertain timeout, 429, offline and stored-but-not-notified states. Preserve safe input; distinguish retry from a second request.

### Traceability

V06, V07, V18, V27, V28. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
