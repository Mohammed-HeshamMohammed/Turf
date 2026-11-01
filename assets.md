# Homepage asset manifest

The homepage implements the selected Precision Studio reference in
`../../docs/plans/web-rebuild/references/selected-property-outreach.png`.
The reference is not embedded as live UI.

- `public/images/property-hero.webp`: generated with OpenAI Image Gen on 2026-11-01 for this implementation; 1536 × 1024. Illustrative contemporary residential architecture, not a property offered for sale. Original generation retained outside the checkout in `/workspace/generated_images/exec-5a3e9cd9-6865-4820-936f-a93d804bc451.png`.
- `public/images/property-hero-mobile.webp`: intentional right-side crop of the same image, 768 × 768. Both assets have explicit dimensions in the hero and responsive sources. HTML carries all essential copy.
- `public/fonts/BarlowCondensed-Bold.ttf`: Barlow Condensed Bold from the Google Fonts repository, `ofl/barlowcondensed/BarlowCondensed-Bold.ttf`. Licensed under SIL Open Font License 1.1; license retained alongside the font. Display headings only; Schibsted Grotesk remains the body/control font.
- `public/screens/{calls,lists,skip,handoffs}.webp`: fresh 1440 × 900 browser captures of this checkout's CRM frontend using its bundled fictional sample workspace, captured 2026-11-01. Owner role, default sample state; no uploaded customer records. Calling is explicitly captioned as a preview. Current Caller Whale branding replaces the old Turf captures. Original PNGs retained in `/workspace/turf-qa/current-*.png` for this task.
- Production whale mark and existing Phosphor icon family are preserved.

Copy is in Home (`src/pages.jsx`), shared FAQ/metadata (`src/content.js`), and the shared header/footer/waitlist (`src/components.jsx`). Pricing arithmetic remains exclusively in `src/plan.js`; the homepage quotes no independent prices.

These assets and local checks do not constitute deployment approval or proof that calling, team sync, notification delivery, or billing are live.

## Human benefit photography

The earlier 3D model-house illustrations were replaced at the owner's request. Houses remain in the hero; the three benefit sections now use candid human work scenes.

Original OpenAI Image Gen assets created 2026-11-01, optimized to 1536 × 1024 WebP:

- `public/images/list-work.webp`: a woman organizing loose property records into clear groups. Original `/workspace/generated_images/exec-752387b8-04f3-4666-afd2-2715a806f9a1.png`.
- `public/images/supported-call.webp`: a man listening on a headset with notes and a laptop close by. Original `/workspace/generated_images/exec-1a97f87a-583e-4ba3-a324-cd10cd2120ae.png`.
- `public/images/team-handoff.webp`: colleagues sharing a notebook and discussing the next step. Original `/workspace/generated_images/exec-d8872df9-4ac1-4f8b-8882-f5d48df1f4f3.png`.

These depict fictional people in illustrative situations, not actual customers or testimonials. Screens face away and contain no customer records. They do not demonstrate live calling or shipped team synchronization. Preview boundaries remain in adjacent copy.

Photos are lazy-loaded with reserved dimensions and meaningful alt text. Captions, sequence labels and badges remain live HTML. The homepage retains exactly one actual app screenshot. Superseded 3D assets were removed from the public build; their original generations remain outside the checkout and their history remains in Git.
