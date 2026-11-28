# Pricing

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /pricing.

## Job

Let people understand feature-based costs and compare a useful configuration without misleading purchase claims.

## Section plan

1. Pricing status and billing assumptions.
2. Team size and feature selections with a persistent local total.
3. Per-feature seat counts and tier rules.
4. Included items, limits and extras.
5. Ready-made configurations opening the same builder.
6. Clear summary and access/contact next step.

## Actions and behavior

Primary: discuss/request the selected configuration. Builder selections survive a recoverable error; do not add a payment button until billing exists.

## Layout and design

Reuse tested plan arithmetic. Keep configuration and summary together on desktop; mobile summary is collapsible without hiding the total or covering controls. Show breakdown before dense comparison detail.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Public/indexable and sitemap. Do not mark draft prices as purchasable offers in structured data.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Existing arithmetic tests remain authoritative. Test minimum/maximum seats, feature Off, mixed seat counts, caps and extras; copied/shared configurations contain no private information.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.

## Detailed implementation brief

### Layout and sequence

Page heading/status -> team size -> feature/seat configuration -> price breakdown -> ready-made configuration shortcuts -> limits/assumptions -> access/contact action. Keep the compact summary visible alongside controls without covering mobile content.

### Copy and visual application

Headline proposal: 'Choose the tools your work needs.' Call prices draft when unresolved. Explain software versus metered/extras cost and the actual unit beside every number.

### Data and service boundary

plan.js and approved feature documents own arithmetic. A quote is an estimate/configuration, not a subscription purchase. No checkout or automatic entitlement endpoint is assumed. Validate any URL-shared configuration against a versioned schema.

### Required edge states

Feature off, zero/maximum/invalid seats, per-feature people counts, incompatible choices, long currency labels, outdated shared quote and reload restore need explicit behavior. No automatic currency conversion without a supported contract.

### Traceability

V01, V03, V06, V09, V30 plus existing pricing arithmetic boundary tests. See [verification matrix](../12-verification-matrix.md), [contracts](../06-architecture-contracts.md) and [component/state rules](../09-components-interactions.md). Acceptance requires implementation evidence; this brief does not claim those integrations already work.
