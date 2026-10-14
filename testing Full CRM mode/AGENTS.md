# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

## Sidebar design preference

The left sidebar must support a persistent minimized icon rail. Use restrained Mac Dock-style magnification for the hovered icon and its neighbors, with a soft local bend in the rail toward the hovered item. Keep a rounded/circular highlight around the selected item. Preserve labels through tooltips and keyboard focus, retain connection controls, respect reduced motion, and keep the mobile drawer readable. The Turf logo opens the app menu; place Explore as inside that menu instead of the sidebar.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
