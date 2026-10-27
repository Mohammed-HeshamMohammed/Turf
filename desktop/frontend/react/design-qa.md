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

## Turf dropdown tools placement

**final result: passed**

- Source truth: the supplied control-strip image `C:/Users/unwie/AppData/Local/Temp/codex-clipboard-2c2f5a8d-6553-4eb9-9bbc-99da00e20763.png` and the instruction to keep those three controls exclusively in the Turf dropdown.
- Implementation evidence: [desktop dropdown](screenshots/menu-only-tools.jpg) and [mobile dropdown](screenshots/menu-only-tools-mobile.jpg). The source strip and mobile implementation were visibly opened in the same comparison input. This is a control-placement comparison, not a pixel-identical crop comparison. Mobile viewport/pixels are **375 × 812**, density **1**.
- Connection preview, Sync & pending changes, and Workspace settings appear together in that order inside the logo menu. The connection row retains the green icon and helpful state label; the menu uses the existing font, white surface, rounded corners, and spacing.
- All three are absent from the expanded/minimized/mobile sidebar. The personal menu no longer repeats the connection label. Footer status is plain text, and the offline banner no longer duplicates the Sync navigation action.
- Checked offline/reconnect toggling, opening Sync, and opening Settings from the dropdown. Caller still sees the Settings entry but cannot activate it; no role access was broadened. Original manager/connection state was restored after verification.
- Browser DOM checks found **0** utility items in the minimized/mobile sidebar and **0** footer buttons. Mobile document width remains **375px**. No actionable P0/P1/P2 finding remains for this placement change.

## Noticeable rounded sidebar hover

**final result: passed**

- Source truth: the user's follow-up that the rail's roundness must be noticeable. The [before capture](screenshots/sidebar-roundness-before.jpg), [expanded result](screenshots/sidebar-roundness-expanded.jpg), [minimized result](screenshots/sidebar-roundness-minimized.jpg), [first item](screenshots/sidebar-roundness-top.jpg), [last item](screenshots/sidebar-roundness-bottom.jpg), and [mobile drawer](screenshots/sidebar-roundness-mobile.jpg) were opened together for visual comparison. Desktop captures are **1313 × 884** at density **1**; mobile is **375 × 812**, density **1**.
- **[P2, corrected] The previous 5px bend was too subtle.** The rail now extends **22px** along a smooth 112px-tall curve with vertical tangents where it meets the rail. Hover highlights use fully rounded ends. The selected circular highlight and centered icon magnification remain intact.
- **[P2, corrected] Curve clearance:** added a 10px desktop gutter so the larger bend clears the page content. Tooltips sit beyond the curve. Font, colors, imagery, data, and menu placement remain consistent with the source.
- First/last hovered items retain the visible curve while its vertical bounds stay away from the rail caps. A checked last-item bend spans **565–677px** inside a rail spanning **94–846px**. No layout translation or cropped icon was found.
- A **1280 × 720** short-window check confirmed all navigation content fits its scroll viewport (**534/534px**). Keyboard focus on Reports exposes the label and bend. Reduced-motion emulation hides the bend and sets icon transform to `none`; emulation was removed afterward.
- Mobile retains a **254px** full-label drawer with the bend hidden and document width **375px**. All three workspace utility controls remain exclusively in the Turf dropdown. Restored the original expanded desktop preference and route without changing sample records.
- Prototype lint, all **10** model/hosting tests, and production build pass. Browser console contains no errors or warnings. No actionable P0/P1/P2 issue remains for this revision.

## Local hover entrance and selection motion

**final result: passed**

- Source truth: the user's request for the curve to come from inside the rail and animate between selections. The previous [rounded-hover capture](screenshots/sidebar-roundness-expanded.jpg) was opened together with the new [expanded](screenshots/sidebar-motion-expanded.jpg), [minimized](screenshots/sidebar-motion-minimized.jpg), and [mobile](screenshots/sidebar-motion-mobile.jpg) captures. Desktop is **1313 × 884**, mobile **375 × 812**, density **1**. Settled geometry, typography, colors, imagery, and content remain consistent; this revision changes motion.
- **[P2, corrected] First hover slid down from the top.** Each new hover session starts at its target's vertical position and grows horizontally from the rail edge. Leaving retracts the curve in place. An early browser sample on Calls measured top **143.766px**, exactly the target center **199.766px minus 56px**, while horizontal scale was **0.142**. The entrance therefore grows locally instead of interpolating from top zero.
- Between hover targets, the existing curve stays fully extended and moves vertically over **280ms**. A checked move toward Reports had intermediate top **165.229px**, target top **500.531px**, and horizontal scale **1**. The small Calls/Deals gap keeps the curve active without restarting its entrance.
- The selected white pill/circle is now one shared marker. It moves between destinations over **300ms**; an observed Leads-to-Tasks transition had intermediate top **142.263px** toward **252.766px**. Its geometry updates on navigation, role changes, sidebar resizing, and the mobile drawer. Checked destination navigation and restored the original Tasks route and expanded preference; sample records were retained.
- Reduced-motion emulation reports selection transition **0s** and a hidden rail bend. Mobile retains readable labels and the selected rounded highlight. Removed temporary emulation and viewport overrides afterward.
- Lint, all **10** model/hosting tests, and the production build pass. Browser console has no errors or warnings. No actionable P0/P1/P2 finding remains for this revision.

## Spacious Skip Tracing and available-evidence fallback

**final result: passed**

- Source truth: the user's feedback that Skip Tracing felt shrunken and should continue with address or other evidence when phone columns are absent. The [before](screenshots/skip-before.jpg), [expanded workspace](screenshots/skip-expanded.jpg), [address fallback](screenshots/skip-address-fallback.jpg), [actual address-only import](screenshots/skip-no-phone-import.jpg), [demo results](screenshots/skip-address-results.jpg), and [mobile fields](screenshots/skip-mobile-fields.jpg) were visibly compared together. Before/expanded/fallback are **1543 × 884**; isolated import/results are **1280 × 720**; mobile is **375 × 812**, density **1**. Different viewport sizes are not treated as pixel-identical comparisons.
- **[P2, corrected] The setup was visually compressed.** The main working column now has a compact 270px context rail, larger 21px card headings, 14px mapping controls with 48px targets, two-column mapping on desktop, readable step labels, and a horizontally scrollable source preview. At 1280px with the sidebar expanded, the stage measures **694px**. The existing font, gray surfaces, peach accents, icon family, and progressive workflow remain consistent.
- **[P2, corrected] A nonexistent Phone column was always offered.** Detection now uses actual header names and populated values. It prefers phone, then address, email, and owner name, and shows counts and the active starting field. Blank/missing phone fields move to the next usable kind. Unrecognized headers can be mapped manually; no usable mapping disables checks. Changing sources resets mappings and previous results.
- Browser checks covered phone-to-address-to-email-to-name fallback, disabled continuation with no evidence, restoring detected mappings on source change, and skipping Call outcomes/default phone region when no populated phone field exists. Phone-only warning controls are disabled, while existing blocked records retain their verdict.
- Imported a two-row CSV containing Owner, Property Address, City, State and ZIP, with **no phone column**, into a separate localhost-origin preview. Address was detected automatically, all original source values remained visible, the four-stage workflow completed, and results showed **2 source rows / 0 ready / 0 repeats**, both Unverified. The original workspace records and role were untouched; the isolated test tab was closed afterward.
- Mobile uses one-column mapping. The page width stays **375px** while only the step strip and preview table scroll horizontally; the checked active step remained fully visible. Temporary viewport overrides were removed. Source selection and mappings in the original preview were restored.
- **[P2, corrected during tests] Numbered camel-case headers:** an added regression case exposed a missing digit/uppercase boundary in header normalization. Fixed it; Owner1PhoneNumber and PropertyAddressLine1 now detect correctly. All **15** tests pass, including missing/blank phone fields, alternative phone columns, all fallback kinds, manual mapping, stale mappings, and empty inputs.
- Lint and production build pass. Browser console has no errors or warnings. No actionable P0/P1/P2 finding remains for this revision. This changes the frontend prototype's mapping and demo workflow; the native matching/provider engine remains outside this prototype.

## Geographic views and comprehensive source mapping

**final result: passed**

- Source truth: the user explicitly chose **both** geographic property maps and column mapping for all source cases. The previous [Skip Tracing layout](screenshots/skip-expanded.jpg) was opened in the same comparison input with [supplied-coordinate cases](screenshots/map-source-cases.jpg), [city areas](screenshots/map-city-areas.jpg), [mobile client scope](screenshots/map-client-mobile.jpg), and [location/mailing mappings](screenshots/mapping-location-fields.jpg). Source/map/mapping desktop comparisons are **1543 × 884** at density **1**, mobile **375 × 812**. The final [original workspace dashboard](screenshots/map-dashboard.jpg) uses its native **1864 × 884** window; no pixel-match claim is made across different sizes or roles.
- Shared Leaflet/OpenStreetMap views now render in Dashboard, Leads Map view, source-list details, Skip Tracing, property details and call context. Controls support pan/zoom, fitting records, location-quality filtering, record selection and opening a property. Basemap attribution stays visible. Existing Inter Tight typography, gray/white cards, peach selections, sidebar geometry, and rounded surfaces were retained.
- Supplied coordinate pins remain explicitly unverified. The four rounded Florida city reference areas use dashed circles labelled approximate, with grouped counts for coincident locations. They are not parcel or municipal boundaries. Address-only, invalid and missing-location records stay in the list without invented pins. An empty-location view explains the missing evidence. Address search is an explicit external link; no automatic geocoding was added.
- An isolated CSV import covered custom Location/Northing/Easting columns, split names, mailing address, call outcome, an extra column, a coordinate record, an address-only record, an invalid pair and a missing-location record. Manual mapping and saving followed by refresh produced **1 coordinate / 0 city areas / 3 needing a location**. Original source values remained intact. The original user workspace was not used for test imports.
- Mapping now covers **23** supported fields, including split names/addresses, units, international location fields, coordinates, parcels, mailing details, value and outcomes. All fields can be corrected; source-specific mappings persist and feed geographic views. Derived names/addresses and coordinate-only sources are supported. Exports retain every original source column. Imported data no longer acquires an invented Tampa/FL location when city/state are absent. New-lead creation accepts international postal codes and optional validated coordinate pairs.
- **[P2, corrected] Mobile map centering:** invalidating size without panning shifted the focal area after narrowing the viewport. Resize handling now preserves the map center. The post-fix mobile capture shows the St. Petersburg area and Patricia's record, with map width **293px** and page/viewport width **375px**.
- **[P2, corrected] Mapping labels and derived values:** gave selectors exact accessible names to distinguish property Address from Mailing address, and kept derived full-name/address summaries separate from actual selectable column values. The field group and saved Northing/Easting selectors were visibly reviewed after correction.
- Client checks showed only Sarah, Patricia and Angela in the map. Searching Patricia reduced it to one record. A keyboard-selected source record opened the grouped area popup and the corresponding property detail. Supplied/approximate/needs-location filters were checked. [Offline preview](screenshots/map-offline.jpg) retained records and location evidence while replacing network tiles with a clear fallback.
- All **20** tests pass, covering coordinate bounds, zero values, missing pairs, international input, separate mailing locations, split names/addresses, coordinate-only evidence, per-source mapping, original-value preservation, blocked status and role denial. Prototype lint and production build pass without warnings. Leaflet is loaded as a separate chunk. Browser console has no errors or warnings after the checked flows.
- Temporary viewport/motion overrides were removed and the isolated test tab closed. The original role and records were preserved, and the original workspace was left displaying its map. Plan, README and AGENTS record the added requirements and prototype boundaries. General geocoding, ZIP centroids, native/server geography, verified parcel locations and offline tile packages remain production follow-ups. No actionable P0/P1/P2 finding remains for this revision.

## Vercel hosting preparation

**Status: deployed; public access and asset parity verified.**

- Added a separate Vercel configuration in the prototype folder with Vite build output `dist/client`. Existing Sites packaging and the main Turf application remain intact. No server credentials or browser-storage contents are included in the upload.
- Configured `npm ci`, the direct Vite build, upload exclusions and `X-Robots-Tag: noindex, nofollow`. Hash routing needs no rewrite. Account/project linkage is ignored by Git.
- Prototype lint, all **20** tests, and production/Sites packaging build pass. Vercel device sign-in completed, and the separate `mohammedheshams-projects/turf-crm-demo` project was created and linked. The deployment dry run confirmed **32 uploaded files**, excluding local credentials, screenshots, tests, dependencies, and Sites files.
- Production: [turf-crm-demo.vercel.app](https://turf-crm-demo.vercel.app/). Immutable deployment: [build 45pFdmYEQgCL6AUKVGWsAkYveTiT](https://turf-crm-demo-8kal3moc2-mohammedheshams-projects.vercel.app). Vercel reported **READY** with the production alias assigned on October 15, 2026. This publishes only the frontend demo; no native service or production CRM backend was deployed.
- An unauthenticated HTTP request without cookies or bypass headers returned **200**, the Turf title, and `X-Robots-Tag: noindex, nofollow`, with no login redirect. All **13** deployed JS/CSS/font/image/favicon files matched SHA-256 hashes of the locally tested build. Entry assets resolved correctly; a nonexistent JS asset returned **404**. Hash routes are resolved by the same previously browser-verified app code.
- The current browser automation session exposed no browser surfaces, so a new hosted interactive browser run could not be performed. Earlier local browser interaction evidence still applies to the identical deployed assets; remote runtime behavior beyond the HTTP/asset checks is not claimed as newly tested. The hosted dashboard was queued for opening in the Codex panel.
- Automatic Git deployments were not enabled. Update this existing project with the documented CLI command. If a future release fails the public/asset checks, do not share that release; redeploy the last known good prototype revision to the same alias.
