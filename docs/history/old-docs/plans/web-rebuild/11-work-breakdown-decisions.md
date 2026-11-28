# Work breakdown, dependencies, decisions and risk

Status: Proposed execution backlog. No implementation complete by this plan.
Parent: [Master plan](README.md).

## Work packages

| ID | Deliverable | Depends on | Acceptance owner role | Exit evidence |
| --- | --- | --- | --- | --- |
| W01 | Current page/section/route/API/config baseline | None | Product + engineering | Keep/improve/remake inventory with source/live distinction |
| W02 | Final capability/copy/access policy | W01 | Product | Reviewed truth/status register; draft pricing explicit |
| W03 | Full home/auth/dashboard layouts in both themes/sizes | Selected direction, W02 | Product + design | All sections and failure states reviewed |
| W04 | Token/component specification and asset manifest | W03 | Design + frontend | States, focus, responsive behavior, rights/contrast recorded |
| W05 | Route registry/rendering/discovery architecture | W01 | Frontend | Existing routes/aliases covered; private output excluded |
| W06 | API/error/session adapter contracts | W01 | Backend + frontend | Actual payload fixtures and listed backend gaps |
| W07 | Auth/security backend prerequisites | W06, decisions | Auth/core owners | Required proofs, assurance, recovery and CORS boundaries tested |
| W08 | Public pages/access forms | W02,W04,W05,W06 | Frontend + landing API | Individual page checks and actual receipt failures pass |
| W09 | Account-entry/recovery pages | W04,W06,W07 | Frontend + auth | Providers/password/challenge/mail paths pass staging |
| W10 | Customer dashboard pages | W04,W06,W09 | Frontend + core | All entitlement states; no fabricated data/actions |
| W11 | Staff elevation and six management areas | W07,W10 | Core + auth + frontend | Scoped mutations, role checks, audit/expiry, private monitoring |
| W12 | Messages/assets/SEO/accessibility/performance integration | W08–W11 | Relevant owners | Real delivery, safe captures, complete matrix |
| W13 | Staging review/release/rollback | W12 | Product + operations | Compatible snapshot/config, live smoke and rollback record |

Roles may be performed by the same person. Do not invent headcount, calendar dates or confident estimates before W01. Estimate each package after dependencies and missing contracts are known.

## Priority

P0 before live account/staff rollout: authorization/elevation/session/recovery/human-check correctness, no private data in public output, working origin/preflight and safe error behavior.
P1 before visual release: complete pages/content/assets, responsive/accessibility states, current routes/metadata, actual form receipt and release access.
P2 after verified baseline: richer history exports, advanced search, expanded preferences and measured polish.
Future: browser CRM parity, billing/checkout, mobile and additional marketing content, each under a separate approved scope.

## Decision register

| ID | Decision | Planning baseline | Implementation gate |
| --- | --- | --- | --- |
| D01 | Visual direction | Selected Precision Studio/property outreach | Full compositions still reviewed |
| D02 | Web surface | Public site + account dashboard + staff mode | Browser CRM is a future option |
| D03 | Signup/access | Invitation-only baseline; identity not entitlement | Confirm source policy before public claims |
| D04 | Browser sessions | Preferred target: same-origin HttpOnly adapter; current bearer fallback evaluated explicitly | Threat/operations review, CSRF/state/compatibility and rollout gates in web-session proposal |
| D05 | Staff assurance/elevation | Fresh strong proof per entry; server scope/expiry | Claims distinguish method; ordinary refresh cannot elevate |
| D06 | Recovery/verification URLs | Support current issued links | Trace mail templates and token semantics before route changes |
| D07 | Pricing | Approved arithmetic; draft where unresolved | No checkout/free-trial promise without real policy/contracts |
| D08 | Analytics/consent | Minimal aggregate, no private replay | Approve destination, retention and consent behavior |
| D09 | Usage/profile capabilities | Render supported data; show gaps explicitly | Historical filters/edits need backend contracts |
| D10 | Communications | Actual service receipts/delivery states | Sender, routing and external delivery tested |
| D11 | Ownership/closure retention | Collect minimal data | Business/legal approves policy matching actual capability |
| D12 | Framework/DNS | Keep existing stack/origin initially | Change only for a demonstrated requirement |

Unknowns are assigned evidence/owner/gates rather than silently decided by a mockup. Visual selection is already settled; do not repeatedly ask the owner to select it.

## Risk register

| Risk | Consequence | Planned control |
| --- | --- | --- |
| Pretty hero but old lower-page UX | Incoherent rebuild | All-section review/full-height evidence |
| Auth callback/refresh race | Used code/repeated login | Single-flight exchange/session operations |
| Backend error lacks CORS | User sees false network failure | Preflight and actual error-response tests |
| Client-only admin timing | Privilege survives UI exit | Server-scoped elevation and activity policy |
| Background polling extends admin | Online-but-unattended privilege | Separate human activity from request activity |
| UI overpromises calling/enrichment | Misleading product sale | Capability truth register + preview labels |
| Invitation saved/mail failed | Duplicate records/confused access | Separate mutation/delivery result and safe resend |
| Stale/fake product captures | Inaccurate trust evidence | Fresh sample capture/provenance audit |
| Unreviewed token storage | Account compromise exposure | D04 threat review and verified session boundary |
| Null/failed data shown as zero | Wrong usage/download decisions | Typed state distinctions and backend status gap work |
| Asset/framework change inflates delivery | Slow page/release churn | Measure baseline; targeted choices before migration |
| Staging robots ships to production | Public pages disappear from search | Host-specific discovery release checks |
| Unknown mutation response retried | Duplicate privileged operation | Reconcile/idempotency contract; no blind POST retries |
| Unbounded project scope | Unfinished coherent release | Explicit phases and future extension register |

## Completion tracking

Each W item starts Planned, becomes In progress only with implementation work, then Implemented/local verified, Staging verified and Production verified with evidence links/commit/date. A documentation merge completes planning work only. Required failed gates block the relevant release; “not tested” is not a pass.
