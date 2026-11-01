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
