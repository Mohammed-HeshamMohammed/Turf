# Usage

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /dashboard/usage (proposed).

## Job

Explain what was used, when, against which limit and remaining balance.

## Section plan

1. Period and timezone context.
2. Used/remaining/limit with clear zero/unlimited semantics from API.
3. Daily chart plus accessible tabular equivalent.
4. Recent usage table, filtering and pagination.
5. Exhausted-limit guidance and authorized export if implemented.

## Actions and behavior

Primary: inspect/filter usage. Filters are validated and shareable only within authorized account context. Export requires a defined backend contract.

## Layout and design

Charts support labels, keyboard alternatives and no color-only meaning. Mobile keeps table controls available with contained scrolling.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex; no sitemap. Data scoped to authorized account/workspace; no shared caching.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Test period boundaries/timezones, no usage, exhausted limit, delayed data, pagination, forbidden workspace and failure. Never calculate an authoritative credit balance solely in browser code.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
