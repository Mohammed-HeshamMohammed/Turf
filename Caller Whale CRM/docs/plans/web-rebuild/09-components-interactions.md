# Components, interaction states and layout behavior

Status: Proposed. Parent: [Master plan](README.md). Visual authority: [Selected direction](05-selected-direction.md).

## Design-system deliverable

For each token document semantic name, light/dark values, purpose and contrast evidence. Cover surfaces/text/borders/focus/status, condensed display vs body type, spacing, widths, radius, elevation and motion. Raw hex values belong to tokens/assets rather than scattered components.

For each component document variants/sizes, DOM semantics, content limits, breakpoints, keyboard behavior, focus transitions, pending/error states and screenshot examples. Do not mechanically apply condensed all-caps headings to fields, tables or long body text.

## Component inventory and behavior

| Component | Required behavior |
| --- | --- |
| Header/mobile navigation | Real links, current location, accessible menu dismissal/focus |
| Sidebar/dashboard shell | Stable desktop geometry; mobile drawer; long labels; route scroll/focus |
| Hero/media layer | Live text, clear overlap, responsive focal points, image failure, reserved dimensions |
| Button/action link | Label names action, visible focus, busy without shifting width, deliberate double-submit guard |
| Fields/password | Persistent labels, help/error association, reveal toggle, autofill, paste/password-manager support |
| Provider button | Configured readiness, equal intentional hierarchy, provider-bound pending/error |
| Human check | Config loading, pending/verified/expired/blocked/offline, preserves entered input |
| Step flow | Back/edit email preserves supported input, stage heading/focus announced, no existence leak |
| Notice/status/toast | Persistent actionable errors inline; toasts only for nonessential confirmation |
| Table/filter/pagination | Stable keys/order, real backend scope, count unknown vs zero, contained mobile overflow |
| Detail drawer | Context retained in list, focus trap/restoration, unsaved change handling |
| Modal confirmation | Specific target/effect, safe focus, cancel; destructive scope explicit |
| FAQ/disclosure | Semantic expanded state, keyboard, no loss of focused independent answer |
| Screenshot enlargement | Actual asset, useful caption, keyboard close/focus restoration |
| Theme preference | System/light/dark, persisted preference, no hydration flash where practical |
| Usage chart | Text/table alternative, period/units, no color-only meaning or fake zero |
| Session/elevation prompt | Server-defined expiry, clear re-auth, no hidden infinite retry |

## Global state contract

| State | Render | Available action |
| --- | --- | --- |
| Initial loading | Size-stable skeleton for private data only | Safe navigation/cancel where useful |
| Empty | Explain what does not exist and why | Authorized next action |
| Background refresh | Keep last confirmed authorized data with time/context | Retry; never disguise stale as current |
| Validation failure | Field message plus summary for long form | Correct without losing unrelated input |
| 401 | Single coordinated refresh then entry if refused | Sign in; preserve safe local destination |
| 403 | Permission/required assurance distinction | Appropriate verification or support, no retry loop |
| 409 | Explain stale/conflicting change | Reload/reconcile, don't overwrite blindly |
| 429 | Retry guidance from actual policy | Wait/cancel; no automatic request storm |
| Offline/timeout | No fabricated success | Reconcile uncertain mutations, retry safe reads |
| 5xx | Plain service failure with request reference if safe | Bounded retry/help |
| Partial failure | Keep independent successful sections | Retry failed section only |
| Revocation/logout | Clear private content immediately on authoritative state | Return to safe account/entry view |

Do not convert all errors to a toast or replace an entire usable page because an unrelated optional widget failed.

## Page/scroll/focus behavior

Navigation updates title, metadata and focus to the main heading; native link semantics remain. Back/forward restores sensible route position. Hash targets clear sticky chrome. Errors never focus an offscreen hidden control.

A destructive confirmation names the target; a save does not close a drawer before the server confirms success. If the response is uncertain, inspect authoritative state before retrying. Disable duplicate submissions but do not make a page impossible to leave.

## Responsive matrix

Review 360/390px, 768px, 1024px and 1440px plus long content and 200% zoom. Mobile form first; stacked editorial stories; sidebar becomes drawer. Tables can have a labeled local scroll region only when columns cannot reflow meaningfully. No global horizontal overflow.

The earlier nearest-edge/collapse preferences apply only to explicitly designed panel/board workspaces. Do not automatically minimize unrelated forms, open FAQs or important error sections.

## Accessibility and motion

Use semantic headings/landmarks and visible focus. Announce meaningful pending/result changes without announcing timers every second. Charts and status need textual equivalents. Honor reduced-motion and forced-color preferences. CAPTCHA must not block access without an understandable recovery route.

Keep essential content available without animation/hover. Motion timings in the selected direction are exploration targets, not a reason to delay real network responses.

## Preference persistence

Persist theme and safe view preferences only. Query parameters may store non-sensitive filters; never passwords, factors, raw account data or elevation state. Persisted state is versioned and cannot confer access. Logout/account switch clears sensitive caches and any user-scoped view state that could leak context.
