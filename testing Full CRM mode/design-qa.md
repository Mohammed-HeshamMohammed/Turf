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

## Sidebar and logo-menu revision

**final result: passed**

The requested revision adds a persistent minimized sidebar, Mac Dock-style icon magnification with neighbor falloff, a soft outward bend, rounded selected edges, and Explore as inside the restored Turf logo menu. The later revision below refines that hover after user feedback.

- Visual baseline: `screenshots/dashboard-desktop.jpg`, the previous Turf CRM layout. The baseline and [expanded sidebar](screenshots/sidebar-expanded.jpg) were opened together with the new [dock hover](screenshots/sidebar-dock-hover.jpg) and [Turf logo menu](screenshots/turf-logo-menu.jpg) in one comparison input.
- Desktop comparison captures are **1280 × 720** pixels/CSS viewport at density **1**. Font, card geometry, palette, imagery, and business data remain consistent. Sidebar geometry, current-role control placement, and the wider content pane in minimized mode are intentional changes from the user's instructions.
- Focused visual review covered the active white circular edge, enlarged icons and their neighbors, local rail bulge, tooltip legibility, and the menu's placement above the sidebar.
- **[P2, corrected] Menu stacking:** the first menu render was partly obscured by the new rail. Raised the header stacking context above the sidebar. `screenshots/turf-logo-menu.jpg` is the post-fix capture; every menu action and Explore as is unobstructed.
- **[P2, corrected] Short-window dock density:** the initial 720px-high rail partly cropped its last visible icon. Added a compact 36px circular target layout at short desktop heights. Post-fix measured nav viewport/content heights are **412/412px** for the manager view, with all its destinations reachable and visible. The new hover capture reflects the compact layout.
- Mobile: **375 × 812**, density **1**. [Logo menu](screenshots/turf-logo-menu-mobile.jpg) remains within the viewport (right edge **355px**); [navigation drawer](screenshots/sidebar-mobile.jpg) uses readable labels and a **254px** width despite a saved minimized desktop preference. Document width remains **375px**.
- Checked minimize/expand, persistence after refresh, destination navigation, selected `aria-current`, keyboard focus labels, role switching through the logo menu, Escape dismissal, click-outside dismissal, and restoring focus to the logo after a menu action.
- Hover measurements: hovered icon scale **1.32**, immediate neighbors approximately **1.157**, second neighbor approximately **1.018**. The rail bulge follows the hovered/focused item rather than changing the page layout.
- Reduced-motion emulation confirmed the rail bend is hidden and icon transforms are `none`; the temporary emulation was then removed.
- The original Caller role was restored after checking manager/role-menu behavior. Existing sample edits were retained.
- Updated guidance in AGENTS.md and README.md records the requested sidebar/menu behavior. No remaining P0/P1/P2 issue was found in this revision.

## Header, personal menu, chart detail, and hover refinement

**final result: passed**

Source truth is the user's three annotated CRM screenshots and subsequent feedback about first/last sidebar hover. The previous [expanded-sidebar capture](screenshots/sidebar-expanded.jpg) and new [header/personal-menu capture](screenshots/header-personal-menu.jpg) were opened together with the new chart screenshots in one comparison input. The comparable desktop header captures are **1280 × 720** pixels/CSS, density **1**; the focused [chart tooltip view](screenshots/call-interval-tooltip.jpg) is **1313 × 884**, matching the working browser's viewport. Mobile captures are **375 × 812**, density **1**. No pixel-match claim is made across the two different desktop viewport sizes.

- Workspace identity now occupies the header next to Turf, replacing Full CRM. The duplicate sidebar identity is removed; record scope and minimize control stay in the rail.
- The avatar opens a personal menu: My profile, Notification preferences, My tasks, and My calendar where the role permits it. It dismisses on Escape/outside click and returns focus appropriately. Workspace/role actions remain in the Turf logo menu. Opening either menu closes the notification panel to prevent overlapping panels.
- Profile display name/email save locally per sample account and survive refresh. Temporary verification edits were restored to the original name. Canonical lead responsibility and activity actors are unchanged. The personal switches affect task/unread-conversation notices; both switches were restored after checking the paused panel. My tasks was checked both from another page and from an already-open task list.
- The chart now uses **42 explicit sample intervals**, six per day, with 84 visible markers across the two series. Hovering between day labels displays date, two-hour interval, calls, reached count, and reach rate. A checked example was Friday Oct 9, **14:00–16:00**, **5 calls**, **2 reached**, **40%**. Arrow-key navigation exposed another interval, and the expandable table contains all 42 rows. Tests confirm the original seven sample daily totals are preserved. These are illustrative intervals, not generated claims about actual communications.
- **[P2, corrected] Edge hover looked distorted.** Removed horizontal translation and changed from index-based enlargement to pointer-distance falloff. Maximum compact icon scale is **1.22**, with lower enlargement near the ends. The rail bend is smaller, constrained away from its rounded caps, and fades out at edge controls. The selected circular edge stays centered. The [bottom-hover capture](screenshots/sidebar-edge-hover.jpg) was recaptured after the correction: button transform **none**, bend opacity **0**, and bend bounds remain inside the rail's vertical bounds.
- Mobile [personal menu](screenshots/personal-menu-mobile.jpg) stays between **69px and 359px** in the 375px viewport. The workspace name remains visible in the header. Mobile [chart details](screenshots/call-interval-mobile.jpg) render the same interval tooltip and document width remains **375px**.
- Required fidelity surfaces were rechecked: bundled Inter Tight and compact hierarchy; preserved gray/peach/black tokens; unchanged property asset and icon family; deliberate header spacing; clear personal menu labels and illustrative chart copy. The supplied screenshots and working page were visibly reviewed, not inferred only from source code.
- Browser checks found no remaining actionable P0/P1/P2 issue. Existing sample records and the user's role were preserved. Build, lint, and **10 model/hosting tests** pass; console errors/warnings were checked after restoring the desktop preview.
