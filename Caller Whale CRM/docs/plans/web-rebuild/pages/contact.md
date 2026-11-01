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
