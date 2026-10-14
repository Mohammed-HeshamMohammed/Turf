# Turf Full CRM prototype — design QA

**final result: passed**

Reviewed on October 15, 2026. This pass covers the separate frontend prototype, not the production CRM/backend plan.

## Comparison target and evidence

- Source visual truth: the current Turf dashboard at `http://127.0.0.1:5183/`, plus its existing font, palette, favicon, and card styles.
- Source capture: `C:\Users\unwie\.codex\visualizations\2026\10\14\01a13c30-4896-71b0-aa29-3143514af819\full-crm-qa\turf-source-desktop.jpg`. Kept outside Git because the source represents the live Turf workspace.
- Implementation: `http://127.0.0.1:5190/`, Team manager, clean fictional sample workspace, Dashboard active, connected preview, no toast/dialog open.
- Implementation screenshot: [screenshots/dashboard-desktop.jpg](screenshots/dashboard-desktop.jpg).
- Source and implementation pixels: **1280 × 720** each. CSS viewport: **1280 × 720**; effective capture density **1**. No scaling or density normalization required for the final desktop comparison.
- Full-view comparison: both images were opened together in the same comparison tool input. This was a comparison of Turf's visual system applied to a CRM extension. The live source has aggregate list metrics and a map; the prototype intentionally has role navigation, CRM metrics, tasks, and a property card. Data and information architecture differ intentionally; pixel-identical screen reproduction was not the goal.
- Focused comparison: the header, pill navigation, metric typography, card corners, and body text were inspected in the equal-size full captures. A separate implementation header capture is available at [screenshots/header-desktop.jpg](screenshots/header-desktop.jpg). These regions are readable at the supplied capture size; a separate source enlargement was unnecessary.
- Mobile: **375 × 812** CSS/pixel capture, effective density **1**. [Dashboard](screenshots/dashboard-mobile.jpg), [lead table after correction](screenshots/leads-mobile.jpg).
- Additional states: [deal pipeline](screenshots/deals-desktop.jpg) and [client partner conversation](screenshots/client-inbox.jpg). These flow captures reflect edited sample state, not the clean final dashboard.

## Required fidelity surfaces

| Surface                 | Finding and decision                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fonts / typography      | Bundled Inter Tight Variable loads locally and was confirmed in computed styles. Black headings, medium 500 weight, compact labels, and large light numeric values preserve Turf's hierarchy. Long headings wrap on mobile.                                                                                               |
| Spacing / layout rhythm | Gray shell, 28px card radii, generous gutters, rounded controls, and an independently scrolling main pane match Turf's design language. The new 228px sidebar is an intentional CRM extension, with internal navigation scrolling at short desktop heights. Mobile uses a drawer and a two-column metric grid.            |
| Colors / tokens         | Existing Turf page `#ececec`, cards `#f7f7f7`, ink `#121212`, peach `#ecc394` / `#fbdfc2`, and green status surfaces are retained. Secondary text is slightly darker for readability. Black active pills and white input surfaces remain consistent.                                                                      |
| Image quality / assets  | Existing Turf favicon is reused. Phosphor supplies icons. The generated 1536 × 1024 fictional house is sharp at card size, crops correctly, and is explicitly labeled illustrative. No live property photograph or dataset was copied into the prototype. The source map is intentionally replaced with CRM work context. |
| Copy / content          | Product copy describes the next action. Sample data, demo calls/messages, simulated checks, provider previews, and planned services are labeled. Client views hide internal notes, source evidence, phone/email, financials, and seller/team threads. Report totals explicitly describe a current snapshot.               |

## Findings and correction history

1. **[P2, corrected] Lead table caused mobile document overflow.** At 375px, the table had its own horizontal scroll area but an absolutely positioned accessibility label escaped that container and enlarged the document to 688px. Added `position: relative` to `.table-scroll`. Post-fix browser evidence: document width **375px**, viewport **375px**, table viewport **307px**, table content **705px**. The table now scrolls inside its card. Recaptured and visibly reviewed `screenshots/leads-mobile.jpg`.
2. **[P2, corrected] Role actions needed consistent destinations and sharing boundaries.** Caller dashboard report navigation was changed to Calls; the calendar action is hidden for roles without Calendar. Partner inbox threads now require explicit sharing instead of inheriting access to every seller conversation for a shared property. Client source labels were removed. Post-fix browser checks confirmed partner context appears and seller SMS/offer messages are absent. The model tests also cover client message isolation.
3. **[P2, corrected] Sync could consume another persona's pending operations.** Conflict preview, resolution, and sync are now scoped to the current actor. Conflicts and communication drafts remain pending. Model tests prove retention of another actor's operation. Browser checks confirmed a refreshed offline note persists, conflict review blocks sync until reviewed, and a draft remains unsent.

No actionable P0/P1/P2 issue remains within the prototype scope. Intended backend gaps are documented in README and the implementation plan, and are not claimed as implemented.

## Browser interaction checks

- All eight role presets render; owner, manager, caller, closer, researcher, admin, client, and solo workspaces expose their corresponding scope and navigation.
- Caller requests Sarah's handoff; closer sees it, accepts it, takes ownership, and gains one deal. Caller cannot accept an incoming handoff addressed to the closer. Repeated acceptance does not duplicate deals.
- Offline note survives browser refresh; pending state appears on the lead and in Sync. Reconnect, preview conflict, keep local change, and simulated sync clear the eligible operation.
- Offline messages are saved as drafts, labeled Not sent, and retained in Sync.
- Client view shows only shared properties/notes/tasks/partner conversations. Internal notes and private seller conversations are absent from the visible page.
- Sample CSV import adds two records, opens the new source list, carries it into Skip Tracing, runs the simulated five-step check, and saves Checked status.
- Demo calls start/end without audio and record an outcome. The queue excludes do-not-call/closed contacts; pure-model tests reject a call action on a blocked contact.
- New lead creation opens the resulting record. A scoped lead export downloads an actual CSV file; both were verified in the browser.
- Deal stage control moves Patricia into Negotiation; pipeline updates immediately. Stage selects provide a keyboard alternative to dragging cards.
- Task creation adds a new item; completion removes it from the Open view. Calendar next-month/Today controls show the expected month.
- Inbox messages update the local thread. Connection preview saves Demo connected status without provider credentials.
- Mobile menu exposes workspace pages and role switching. Desktop and mobile images load successfully. The fixed app controls remain reachable.
- Browser console was checked after the final desktop reset/capture: **no error or warning entries**.

## Verification and limits

- Prototype lint, build, and eight model/hosting tests pass.
- Existing Turf root lint and frontend build pass. The root build retains its existing bundle-size warning.
- The prototype build separates chart code into its own chunk and completes without a chunk-size warning.
- This QA does not validate real Tauri packaging, server authorization, provider delivery, native matching, multicore speedups, encryption, or server synchronization. Those components are not connected in this prototype.
- Follow-up P3 polish: add a richer month agenda on very small screens and review sidebar density with users who work at short window heights.

## Completed checklist

- [x] Current Turf source opened and visually compared with implementation.
- [x] Typography, spacing, palette, assets, and copy reviewed.
- [x] Desktop and narrow mobile states captured and inspected.
- [x] Core workflow and role transitions tested in the browser.
- [x] Mobile overflow corrected and recaptured.
- [x] Build, lint, model tests, and console checked.
- [x] Actual prototype boundaries documented.
