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

## Benefit illustrations

Three original OpenAI Image Gen illustrations created on 2026-11-01, optimized as 1536 × 1024 WebP assets. These are marketing metaphors, not app captures, real listings, or proof of live telephony. Copy, sequence labels and badges remain live HTML.

- `public/images/data-to-order.webp`: scattered paper records resolving into an ordered row of architectural property models. Original: `/workspace/generated_images/exec-17ec1009-0134-4795-8093-9d0c3f81deb0.png`.
- `public/images/call-assistance.webp`: a handset, property model and context cards illustrating keeping useful information close while listening. Original: `/workspace/generated_images/exec-20796d9a-40e1-4473-a88a-9ad066c22208.png`.
- `public/images/follow-through.webp`: connected property-model platforms illustrating continuity between an outcome and the next follow-up. Original: `/workspace/generated_images/exec-d9335276-166d-46d4-af0c-1050e3b9eeb1.png`.

All three share the selected ivory/charcoal/peach architectural direction and are lazy-loaded with reserved dimensions. The homepage still includes exactly one genuine app screenshot in workspace proof.
