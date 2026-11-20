# Features

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /features.

## Job

Explain what each product feature does and which parts are ready.

## Section plan

1. Brief workflow navigation with stable feature anchors.
2. Per-feature section: problem, actual capability, real screen, availability and limitation.
3. How the features share data; no fictional cross-feature automation.
4. Relevant pricing/access next step.

## Actions and behavior

Feature anchors are native links. CTA carries feature interest without implying checkout is live.

## Layout and design

Use a consistent alternating composition only when it helps reading. Do not distort screenshot aspect ratios. Provide readable captions and image enlargement with keyboard support if needed.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Public/indexable; one canonical page initially. Do not generate thin feature-detail pages for search alone.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Every capability maps to docs/features or a verified implementation; Coming/Preview labels are consistent. Deep-linked anchors work on reload and keyboard focus is sensible.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Start with the four-step workflow and stable feature anchors. Then organize actual feature sections around Lists, phone-evidence review, outreach preview, deals/follow-up, map, collaboration and exports. Each has one job, proof image, readiness label and limitation before its CTA.

### Copy and visual application

Headline proposal: 'A clearer workflow for every property lead.' Keep short headings condensed and body copy normal. Architectural crops are small separators; product screenshots do most of the explanatory work.

### Data and service boundary

Reuse the source capability register and stable ids such as lists/skip/dialer/map/crm. Client controls do not change availability labels. Do not present a feature matrix as a configured live service.

### Required edge states

Long capabilities/translated labels, missing screenshots, mixed working/preview states, hash deep links and mobile anchor navigation must remain understandable.

### Traceability

V01–V06, V28, V30. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
