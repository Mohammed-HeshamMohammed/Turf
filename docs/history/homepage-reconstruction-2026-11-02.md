# Homepage reconstruction — 2026-11-02

Scope: homepage, shared footer, and supplied temporary logo. Auth, infrastructure, app dashboard, pricing calculations and API behavior remain outside this frontend change.

| Region | Decision | Implemented treatment |
| --- | --- | --- |
| Header | Improve | Supplied orca, consistent optical size, existing navigation and invitation entry preserved. |
| Hero | Remake | Sentence-case type, three short lines, restrained property image transition, direct waitlist and workspace links. Tablet and phone place the image below the copy. |
| Workflow | Keep / refine | Four real stages and existing global motion controls, quieter labels and spacing. |
| Product proof | Remake | One full-width actual sample workspace, explicit preview status, three concise before/during/after notes. |
| Benefit stories | Consolidate | Two image-and-copy stories, no floating image badges or repeated mini-workflows. |
| Team / data / pricing | Consolidate | Removed repeated team pitch; plans and data export share one practical section. Preview restrictions remain clear. |
| FAQ | Reduce | Five relevant homepage questions. Independent keyboard-operable disclosures preserved. |
| Waitlist | Improve | Concise invitation explanation, email first, optional fields side by side, existing backend and validation preserved. |
| Footer | Remake | Closing line and contact link, brand and three navigation groups, separate accessible controls with clearance for the floating entry button. |

## Layout and visual system

Use the existing cream, charcoal and peach palette with a mirrored dark mode. Typography is Schibsted Grotesk with sentence-case headings, one consistent fluid gutter, and readable paragraph lengths. Home content has no fixed 1280/1440 width cap. Headline and image separate at 960px; story rows stack at 600px. The footer retains legal links, motion preference and system/light/dark controls.

The original supplied PNG is stored unchanged under `public/brand`. The header/footer and favicon display its orca through an SVG viewBox; no new animal mark was invented. Permanent logo safe-area rules are [TBD]. Existing product screenshot still depicts the older in-app logo because the screenshot is historical product evidence, not a generated replacement.

See `homepage-layout-sheet.html` for monochrome dimensional architecture derived from the implemented CSS. Other routes retain their page-specific layouts and inherit the revised shared footer and mark.
