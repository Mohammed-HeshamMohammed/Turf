# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

## Sidebar design preference

The left sidebar must support a persistent minimized icon rail. Use Mac Dock-style magnification for the hovered icon and its neighbors, with a clearly noticeable rounded bend in the rail toward the hovered item. The previous 5px bend was too subtle: use a pronounced smooth contour and rounded hover highlights. Keep a rounded/circular highlight around the selected item. Preserve labels through tooltips and keyboard focus, respect reduced motion, and keep the mobile drawer readable. The Turf logo opens the app menu; place Explore as and connection controls inside that menu instead of the sidebar.

The workspace identity belongs beside Turf in the header, replacing Full CRM, rather than in the sidebar. The avatar opens a separate personal menu with profile and personal preferences. Charts need visible, hoverable interval points between day labels, with meaningful time/count details. Keep sidebar hover centered at the first/last items; contain the visible rail bend away from its rounded ends without distorting the caps.

On first hover, the curve must emerge outward from inside the rail at that item's position, never travel down from the top. Keep its last position while retracting. Glide the existing curve between neighboring items, including across their small gaps, and animate the shared rounded selection highlight between destinations. Reduced motion disables all these transitions.

Connection preview, Sync & pending changes, and Workspace settings belong only in the Turf logo dropdown, grouped together in that order. Keep them out of the expanded/minimized/mobile sidebar and personal menu. Footer/banner status may be informative but must not duplicate those navigation actions. Workspace settings remain disabled for roles without access.

Skip Tracing needs a spacious working area with readable controls, source-field mapping, and an original-value preview. Detect actual source fields rather than inventing a Phone column. Prefer populated phone evidence, then address, email, and owner name; show the active fallback and skip phone-only steps when no populated phone field exists. Let users correct mappings and require a usable field before checking. Preserve the progressive workflow and original source values.

Both geographic maps and comprehensive column mapping belong in the CRM prototype. Support split names/addresses, property versus mailing details, international address parts, coordinates, parcels, values and call outcomes. Save mappings per source without changing original values or blocked status. Geographic views must respect visible-record scope and filters, distinguish supplied coordinates from approximate areas, and retain address-only, invalid-coordinate, missing-location and offline cases without inventing property pins. Keep address searches user-triggered.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## Design decisions (product design pass, October 2026)

- One navigation: the sidebar. There are no top tabs; the header holds the Turf menu, workspace, a centred search, the bell and the avatar.
- Page titles are the page's plain name ("Leads", "Calls") with at most one short functional line under them. No eyebrow lines and no slogan headlines.
- Nothing is smaller than 12px.
- Motion is brief and only explains something: a 180ms page fade, menus and dialogs popping, board drag. No staggered rows, no text animations, no exit ghosts or waits between pages.
- Notes that only explain the demo ("sample photo", "no number is dialled", "prototype does not record") carry the `demo-note` class and are hidden unless "Show demo notes" is on in the Turf menu's Sample workspace section, next to Explore as and Reset.
- Calls has a focus mode: while a call is live the queue is hidden and the outcome card sits directly under the person. History and the map share one "About this lead" card with tabs.
- Detail pages keep one primary action in the header (the lead page: Call); secondary and destructive actions go in the More menu.
- The overview opens with "Needs you today": due tasks, expected callbacks, handoffs to accept and unread messages, each with the one action that deals with it.
- Every on/off setting is the same switch (`Checkbox` renders it). Table row selection keeps plain checkboxes.
- Reversible removals (archive a lead, delete a task or note) happen at once with Undo in the toast. Permanent removals (delete a lead for good, delete a deal) still ask first.
