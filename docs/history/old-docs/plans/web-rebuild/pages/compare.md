# Why Caller Whale

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /compare.

## Job

Help visitors decide whether the product fits their workflow.

## Section plan

1. Intended audience and common workflow.
2. What is consolidated and what remains external.
3. Transparent fit/not-fit table.
4. Operational limitations and availability.
5. Links to feature evidence and pricing.

## Actions and behavior

Primary: inspect relevant features or request access; no unsupported competitor claims.

## Layout and design

Use clear comparisons and short examples. Avoid repetitive feature-card grids that add no decision information.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Public/indexable and sitemap. Comparison title accurately describes content.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Every claim has a source in current product behavior. No fabricated competitor prices or savings. Tables remain understandable on mobile and with assistive technology.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Short fit statement -> workflow comparison rows -> consolidation with evidence -> limitations/not-fit -> relevant feature links -> pricing/access next step. Use strong rules and open rows rather than decorative scorecards.

### Copy and visual application

Headline proposal: 'Less copying between tools. More context for the next step.' Keep the consolidation claim qualified by feature readiness.

### Data and service boundary

Approved current capabilities are the comparison source. Do not infer every external subscription can already be removed. Competitor names/prices need a dated source and review before introduction.

### Required edge states

Readable narrow table/list alternative, long content and missing capability evidence. Withhold unsupported claims rather than show a fake score.

### Traceability

V01–V06, V30. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
