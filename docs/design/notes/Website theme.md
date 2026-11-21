# Caller Whale website: main theme

Last reviewed: 3 November 2026. Status: **proposal for the owner to approve.** Nothing here is implemented yet.

This is the one theme for every page of the public site (home, features, pricing, security, contact, sign-in and sign-up). It sits beside [Caller Whale identity and goals](Caller%20Whale%20identity%20and%20goals.md), which says who we are; this note says how the site should look and feel. It replaces the "Precision Studio" direction in `docs/plans/web-rebuild/05-selected-direction.md` wherever the two disagree.

## 1. What is wrong with the site today

Seen on callerwhale.com on 3 November 2026.

| Problem | Evidence |
| --- | --- |
| It looks like a template, not a product with a point of view. | Cream page, rounded cards, peach button, a stock-style street photo. Nothing is recognisably Caller Whale except the small orca. |
| The orca, our one strong asset, is a 38 px icon. | The brand has a whale-first identity but the page never uses it as a shape. |
| The hero photo fights the headline. | Houses fade in behind the copy with a mask; on the dark theme the text and photo both go muddy. |
| Scroll-reveal animation hides content until it is seen. | Content is in the page, but it depends on scripts. Reveals must never leave a page empty. (An earlier version of this note said sections were blank; that was my browser pane failing to draw while hidden, not a site fault.) |
| Too many treatments. | `studio.css` (1,349 lines) plus `pages.css`, `home.css`, `builder.css`, `account.css`: five stylesheets layering over each other, each page its own mood. |
| Tiny type. | Labels at 11 px and captions at 11 px carry real information. |
| Product proof is a screenshot of the old app. | The screenshot still shows the older logo and a lighter UI than the app has now. |
| Two themes, neither decided. | Light and dark both exist, but neither was designed on purpose. |

## 2. What the references do well

Looked at on 3 November 2026. We take principles, not layouts or copy.

| Site | Take | Leave |
| --- | --- | --- |
| [softfix.dev](https://softfix.dev) (the owner's own studio) | One bold idea carries the whole page: giant lettering, a dark navy field with a soft glow, a terminal line (`softfix:~$ build web-app`), small mono labels such as `EST. 2026`, `{/} SERVICES`, numbered sections `01 / 02 / 03`. Short imperative lines: Build. Fix. Scale. It feels made by people who build. | A developer-studio voice. Caller Whale sells to property operators, not engineers; the terminal gag does not carry over. |
| [21st.dev](https://21st.dev) | Near-black page, one electric accent, a large two-line headline, then the real product inside a framed window straight under the headline. Pill nav. Everything is a crisp component. | Blue-on-black developer palette. |
| [Kombai Gallery](https://kombai.com/gallery/web/) | A dark, quiet field where the work is the star. One expressive serif italic word (*standout*) inside a sans headline gives personality for almost no cost. Filter pills as navigation. | Gallery-grid layout. |
| [Linear](https://linear.app) | Restraint: black, one logo, tiny nav, huge empty space, product shown large. Hierarchy comes from size and spacing, not decoration. | Abstract product copy. |
| [Close](https://close.com) | Nearest competitor in tone: one plain promise ("The CRM that sells with you"), an email box in the hero, then a live-looking app frame. Light, friendly, clear. | Pastel gradient waves; it reads generic. |
| [REsimpli](https://resimpli.com) | Knows its buyer: real-estate investors, one giant word, feature chips in one row. | Loud teal-and-red, sticker badges, "unlimited" shouting. |
| [BatchDialer](https://batchdialer.com) | Shows a real screen in the hero with proof (4.9 rating). | Stock-photo hero, all-caps shouting, dense navy. |

### Deeper pass: Kombai Gallery and 21st.dev (3 November 2026)

**Kombai Gallery** lists 140 landing pages, 370 heroes and 299 navbars, and each entry publishes its palette, type and spacing tokens. Read: Midnight Studio, Nightfall, Lumen, Prism, Vesper.

| Pattern seen in the dark ones | Examples |
| --- | --- |
| Near-black page, never pure grey: `#0B0F1A`, `#0A0F1E`, `#0D0A08`, `#000` | Midnight Studio, Nightfall, Lumen, Vesper |
| One warm accent: amber `#F5A623`, gold `#E8AF4A`, orange `#F97316`, sand `#D4A574` | all of them |
| Display in an elegant serif (Instrument Serif, Fraunces, Playfair), body in a plain sans, labels in small mono (Space Mono, JetBrains Mono) | Lumen, Prism, Vesper, Nightfall |
| Very large, fluid display type, `clamp(56px, 11.5vw, 196px)` | Prism |
| Hairlines at 8 to 18% opacity instead of boxes | Midnight Studio, Prism, Nightfall |
| Muted text at 55% of the ink colour, never mid-grey | Lumen, Prism |
| Numbered principles with big serif numerals | Lumen, Vesper |

Take: this is the same family as Deep water, which is reassuring. The one change it suggests is to make the serif a bigger part of the headline than a single word.

**21st.dev** (284 hero components, 354 templates, 956 themes). The hero grid and template list show: a dark field with one soft light source (a glow, an orbit, a planet horizon), a centred or left two-line headline, one primary button, and the product dashboard inside a window directly under it ("Give your big idea the website it deserves" with a CRM dashboard below is the closest match). Template names worth studying for structure: AI CRM dashboard, Folio data-intelligence landing, Qronos AI/SaaS product, Waymark multipage SaaS. Take: soft glow + product window. Leave: shader and WebGL backgrounds, which cost performance and are not needed.

**What the property-outreach competitors share:** loud colour, stock photos, feature lists. Nobody in the niche looks calm, premium or confident. That is the opening.

## 3. The theme: "Deep water"

**One sentence:** a calm, dark, confident site where the orca is the hero shape and the real product is the proof.

The whale lives in deep water: dark, quiet, powerful. The theme borrows that. It is dark first, with one warm accent so it never feels cold, and almost no decoration. The product screen does the selling.

### Principles

1. **The orca is the picture.** Use the supplied black-and-white orca as a large, cropped, low-contrast shape behind or beside the hero headline (water, not houses). Houses stay out of the hero; property appears only in sample data and in the story sections.
2. **The product is the proof.** From the first scroll the visitor sees the real app in a framed window (the 21st.dev and Close pattern), with an honest "sample data" caption. Use a fresh capture; the current one shows the old logo.
3. **Few words, big.** Short headlines in two or three lines. One italic serif word per page for character (the Kombai trick), never more.
4. **One accent.** Keep Caller Whale's peach as the single accent on a near-black field. No second colour except status (green, red) in the product frame.
5. **Numbered, mono labels.** Section labels in small monospace (`01 / WORKSPACE`), borrowed from softfix.dev, so the family resemblance with the owner's studio is clear without copying its look.
6. **Calm motion only.** Content is always visible without JavaScript and without scrolling triggers. Motion is a short fade or rise (150–250 ms), off for reduced-motion.
7. **Honest.** Preview and not-yet-available features stay labelled, as the identity brief requires.

### Colour (proposed, to be tested for contrast)

| Token | Value | Use |
| --- | --- | --- |
| `--deep` | `#0B0F12` | Page background |
| `--deep-2` | `#12181D` | Raised surfaces, product frame |
| `--deep-3` | `#1A222A` | Wells, inputs |
| `--line` | `#26313B` | Hairlines |
| `--ink` | `#EEF1F3` | Main text |
| `--muted` | `#9AA7B2` | Secondary text (check 4.5:1 on `--deep`) |
| `--accent` | `#FFB594` | The single accent: buttons, one highlighted word, focus ring |
| `--accent-ink` | `#2A1608` | Text on the accent |
| `--glow` | `#16384A` at 40% | One soft radial glow behind the hero, deep-sea blue, nothing else |

Light theme: keep it, but derive it from the same tokens (warm white `#F6F4F0` page, same accent, same type), and design it deliberately rather than as an inversion. Default to the visitor's system setting; the hero looks best dark.

### Type

| Role | Choice | Note |
| --- | --- | --- |
| Display | Schibsted Grotesk (already loaded), weight 600, tight tracking, 56–96 px | Keep the font so no new licence or download is needed |
| Accent word | A serif italic (candidates: Instrument Serif, Fraunces). Verify licence and file size before choosing | One word per page |
| Labels and figures | A monospace (candidates: JetBrains Mono, Geist Mono) at 12–13 px minimum | Numbers, section labels, status |
| Body | Schibsted Grotesk 17–18 px, line height 1.6 | Never below 14 px for anything that informs |

### Layout

- One content width (about 1200 px), one fluid gutter, a 4 px scale with 8 px multiples.
- Sections are open on the dark field, separated by hairlines and space, not cards inside cards.
- Radius: 12 px for framed windows and cards, pill for buttons and nav. Nothing else.
- Hero: copy left, the product window large and slightly cropped at the bottom edge, orca shape behind. On a phone, copy first, then the product window.

### Components (one set, reused everywhere)

Top bar (pill, blurred, sticky) · primary and secondary button · mono label · section heading with optional serif word · product window (title bar, caption) · feature row (mono number, title, text, small screen) · price card · FAQ disclosure · footer. Sign-in and sign-up use the same field, button and glow, on one narrow card; no photo panel.

## 4. Page by page

| Page | Job | Change |
| --- | --- | --- |
| Home | Say what it is in five seconds, show the app, get a waitlist email | Hero with orca, large product window, three numbered steps (record, call, follow up), one story with real sample data, short FAQ, waitlist |
| Features | Prove each feature | Alternating rows, each with a real capture and a working/coming badge |
| Pricing | Let people build a plan | Keep the builder logic; restyle controls and tables to the theme |
| Security | Build trust | Plain text, mono figures, fewer boxes |
| Contact | Reach us | One form on the dark field |
| Sign-in and sign-up | Get in | Single card, theme tokens, no photo |
| Privacy and terms | Be readable | Narrow column, no hero image |

## 5. Rules to avoid sliding back

- One stylesheet of tokens (colour, type, space, radius); pages add layout only. Retire the overlapping `studio.css` overrides as each page moves over.
- No stock or generated photos in the hero. Property imagery only where it illustrates a story, with its provenance recorded.
- No page may be blank before scroll or without JavaScript.
- No text smaller than 12 px; informative text 14 px or larger.
- Every new section is checked at 375, 768 and 1440 px, in both themes, and with reduced motion.

## 6. Open questions for the owner

1. **Dark first?** This proposal makes dark the default. Is that right, or should the first impression stay light?
2. **Accent.** Keep peach, or try a cooler accent that reads more "ocean"?
3. **Serif accent word.** Approve the idea? If yes, pick the font after a licence and size check.
4. **Orca as large shape.** Is the temporary artwork acceptable at hero size, or does it need a vector redraw first? (Brand notes say permanent artwork is still to be reviewed.)
5. **Fresh product capture.** The hero depends on a current screenshot of the app with sample data. Who takes it, and when?
6. **Scope.** Start with Home only as the proof of the theme, then roll it to the other pages?

## 7. The desktop app and this theme

Status: **proposal only; no app code has changed.**

Today the app (`apps/crm/src/crm.css`) is light only. It uses a grey page (`#ececec`), grey cards, a tan accent (`#ecc394`), 28 px corner radius, 14 px base type and Schibsted Grotesk throughout. The website's old light theme was copied from it, so the two matched; the new Home no longer does. Until the app moves, a visitor sees a dark site and a light app. That is acceptable for the first release of the theme but should not last.

Rules for bringing the app in line:

| Area | Direction |
| --- | --- |
| Colour | Same tokens as section 3: the app gets a dark theme built from them (`--page`, `--card`, `--raised`, `--line`, `--ink`, `--muted`, `--accent`). Light stays available and keeps its own tokens. System setting decides the default; the website's dark-first default does not apply inside a work tool. |
| Accent | Peach `#FFB594` replaces the tan `#ecc394`, in both themes, so a button looks the same on the site and in the app. |
| Type | Schibsted Grotesk stays for everything. The serif italic is for marketing only and must not appear in tables, forms or dialogs. Mono is allowed for phone numbers, IDs and timestamps. |
| Size | Base 14 px stays (dense work screen). Nothing below 12 px. |
| Radius | Reduce 28 px to 12 px for panels and keep pills for buttons and chips, matching the site. |
| Density | Hairline dividers over boxes, as on the site, but keep the app's compact rows. |
| Imagery | No orca watermark behind working screens. The orca appears only on sign-in, empty states and the about dialog. |
| Status colours | Green, red and amber for status are kept and given dark-theme variants with the same contrast rules. |

Order of work: introduce the shared tokens in `crm.css` behind a `data-theme` switch, restyle the shell (rail, top bar, buttons, inputs), then each screen. After that, re-capture the product screenshots used on the site so the site shows the app as it really looks. Contrast and a screen-by-screen review (keep, improve or remake each section) are still to do.

## 8. Built so far (Home only)

Home now uses this theme: `landing/web/src/Home.jsx` and `landing/web/src/deep.css`. Dark is the default (saved choice and the Appearance menu still work); fonts added are Instrument Serif italic and JetBrains Mono, both self-hosted. Checked at 1440 and 390 px, dark and light, with no horizontal overflow, and the 31 site unit tests pass. The other pages inherit only the new dark colours and are not yet restyled. The old Home styles (`home.css`, the `editorial-home` class) are no longer used by Home and can be deleted once the other pages move.

## 9. Not done yet

- No mock-up or prototype exists; the colours and fonts above are proposals.
- Contrast has not been measured.
- Reference sites were viewed at the top of the page only; competitor pricing pages and mobile layouts were not reviewed.
