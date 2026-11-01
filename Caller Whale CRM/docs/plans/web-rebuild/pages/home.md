# Complete landing-page remake

Status: **Main visual direction selected; detailed layout and copy proposed. Planning only.**
Route: /. Parent: [Web rebuild plan](../README.md).
Visual authority: [Selected Precision Studio direction](../05-selected-direction.md).

## Goal and scope

Remake the entire homepage from navigation to footer around Caller Whale's property-outreach workflow. Explain the desktop product, show genuine software evidence, communicate availability and lead to an appropriate access flow. The selected concept guides the whole composition; it is not a new hero above an otherwise untouched page.

Cover desktop/mobile, light/dark, copy, imagery, interactions, failure states, discovery and release acceptance. Other public pages inherit the shared selected style through their individual plans. Account/dashboard implementation remains a separate stage.

## Story and draft hero copy

Sequence: understand the job -> see the workflow -> inspect actual software -> understand individual/team use -> choose the next step.

- Overline: **Built for property outreach**.
- H1: **Your lists. Your next conversation.**
- Paragraph: **Organize property lists, review phone evidence and keep every follow-up in view.**
- Hero action: **Explore the workflow** -> /#workflow.
- Secondary text link: **See the desktop app** -> /#workspace.
- Header conversion action: **Request access** -> /#request-access.

“Tools for a more focused tomorrow” informs the editorial label style; use a business-specific public overline so visitors can identify the product immediately. Copy remains subject to capability/readiness review.

## Existing-section disposition

Source audit: Home in landing/web/src/pages.jsx and marketing wrappers in App.jsx. This is source evidence, not a completed visual audit.

| Current area | Decision | Replacement or improvement |
| --- | --- | --- |
| Header | Improve | Product/workflow/pricing, sign-in and one access action |
| Hero plus large Calls image | Remake | Layered residential architecture; product proof follows the workflow |
| Five subscriptions/one app strip | Replace | Workflow relationship; no automatic savings claim |
| Full feature-card grid | Remake | Editorial stories with selected genuine product screens |
| Four-screen tour | Improve | Current captures linked to specific work; reduce repetition |
| How it works/principles | Merge | One four-step workflow and compact continuity section |
| Audience grid | Improve | Clear individual/caller/closer/team use in open rows |
| Four pricing cards | Simplify | Pricing model preview linking to the tested builder |
| FAQ | Improve | Access, readiness, data, pricing and platform answers |
| Appended invite/waitlist blocks | Remake | One intentional access section, no duplicated forms |
| Footer | Improve | Useful product/legal/help links and theme control |

## Full page structure

### 1. Header

Keep the production brand mark. Product -> /features; Workflow -> /#workflow; Pricing -> /pricing; Sign in -> /signin; Request access -> /#request-access. Signed-in visitors may see Open dashboard once session state is known, without blocking the public page or exposing staff tools.

Use a horizontal bar with a fine lower rule. Mobile menu has a real expanded-state button, logical focus, Escape dismissal and focus restoration. If sticky, ensure anchor targets/focus clear the header. No surprising control movement on scroll.

### 2. Hero

Warm ivory, large condensed live-text headline and residential architecture extending from the right behind selected text edges. Preserve clear reading space, deliberate crop and restrained peach actions. The photograph provides property context; it is not an available property listing.

No fake trust badges, invented customer counts or sales claims. Mobile orders headline, paragraph and actions before the photo; reduce overlap when needed. Reserve image dimensions and retain readable text if the image fails.

### 3. Workflow — /#workflow

Four numbered steps: **Import lists -> Review numbers -> Prepare calls -> Track follow-ups**. Open ordered structure with thin rules and brief supporting sentences. Phone review describes supplied evidence; call preparation does not imply launched live telephony.

Stack as a vertical ordered list on phones. Arrows are decorative. If a step is interactive, give it an actual destination; otherwise do not style it as a button.

### 4. Product proof — /#workspace

Overline: **The workspace behind the outreach**. Heading: **Keep the conversation and the next step together.**

Show one substantial current product capture alongside three concise ideas: a list with context, a conversation with history, a follow-up with an owner. Choose the screenshot after checking current readiness. Calls must retain an adjacent **Sample workspace · calling preview** caption where applicable.

Use actual UI, not the concept image's generated rendering. Mobile puts explanation before the image. Provide an accessible enlargement if useful; tiny screenshot text must not be the only explanation. Preserve aspect ratio and safe sample data.

### 5. Three editorial product stories

| Story | Evidence | Copy boundary |
| --- | --- | --- |
| Bring structure to the list | Current Lists/column mapping screen | Original data and actual offline scope |
| Review before reaching out | Phone-evidence review or call preparation | Rank supplied evidence; label calling preview |
| Keep the next step owned | Current tasks/history/handoff screen | Describe only verified assignment/follow-up behavior |

Each story has a short label, one heading, two or three useful points, real screenshot and relevant Features anchor. Vary composition where it helps reading; do not make three identical cards. Architecture supports these sections rather than replacing product evidence.

### 6. Individual and team use

Heading proposal: **A clear next step, whoever owns it.** Explain a solo operator managing their list, a caller recording outcomes and a closer/team member receiving context. Use open rows and subtle rules; label preview-only role behavior.

Link to relevant feature details. No invented productivity, sales or seat claims beyond approved product/pricing sources.

### 7. Data and continuity

Explain keeping original records, exports and the desktop workflow. State offline capability by operation: local work may continue; online calling, authorization or enrichment depend on connectivity as applicable. Never say every feature works offline.

Link to /security for verified details. No unverified encryption, certification or unlimited-processing promises.

### 8. Pricing preview

Heading proposal: **Choose the tools your work needs.** Explain feature-based configuration and team choices from approved documents. **Build your plan** links to /pricing. Prefer a compact explanation to duplicating the full table; numbers remain visibly draft when not approved.

Reuse plan.js arithmetic if showing a quote. No homepage-only calculations, checkout or instant activation promise without the actual supporting flow.

### 9. FAQ

Answer: What is Caller Whale for? What works today versus preview? Can I import my spreadsheet? What works offline? How do invitations/desktop access work? How is pricing structured?

Use accessible disclosures with answers present in initial HTML. Independent answers may stay open; opening another must not remove focused content. Avoid sensitive/internal URLs.

### 10. Access section — /#request-access

One clear section explains the actual invitation/waitlist process. Email required; collect name/team/workflow context only if the receiving contract supports it. Marketing consent is explicit/separate where required.

Use **Request access** only when the service actually records/routes access requests; otherwise label submission **Join the waitlist** with honest supporting text. A receipt does not create an identity, workspace, invitation or download entitlement.

Keep /#waitlist as a compatibility anchor to this same section. Integrate the existing landing API contract; do not invent an endpoint or imply notification delivery when only storage succeeded.

Design idle, validating, submitting, accepted, duplicate, 429, offline and server-error states. Preserve input on recoverable errors and prevent duplicate submissions. If this endpoint requires human verification, its receiving backend validates it; auth's CAPTCHA does not protect unrelated forms. Handle expiration, blocked scripts and retries without losing text.

### 11. Footer

Group Features/Pricing/Why Caller Whale; Contact/Security; Privacy/Terms; Sign in or Dashboard as appropriate. Theme selector offers system/light/dark with clear labels. No public admin/monitoring links, invented social links, unowned support address or repeated access form.

## Components, assets and states

Define navigation/mobile menu, layered hero, workflow, section heading, screenshot/caption/enlargement, story row, audience row, pricing preview, FAQ, access form, messages, footer and theme selector. Each has hover/focus/busy/open/disabled and applicable error states. Static content should not wait behind unnecessary loading animations.

Asset manifest: residential hero with intentional desktop/mobile crops; separate account photo for the later auth stage; fresh Lists/evidence/follow-up captures and labeled Calls preview; licensed condensed display font with tested fallback; readable body font; factual social preview; one reviewed copy source. Audit old Turf branding, private names/numbers/addresses and stale UI before publication.

Supply responsive sources, dimensions, focal points and captions. Load the hero promptly and lower images lazily. Do not use the concept sheet as the live hero or bake headings into a bitmap.

## Mobile, themes and accessibility

Review 360/390px phones, 768px tablet and 1024/1440px desktop plus 200% zoom. Keep semantic headings, real text, readable labels, keyboard focus and skip link. No accidental page overflow. Large app images need a deliberate viewing strategy rather than unreadable miniatures.

Dark mode rebalances surfaces, photo contrast, rules and screenshot framing; it does not invert photos. Peach uses charcoal text. Start with system preference and remember an explicit choice. Respect reduced motion; content/links remain readable without JS and form limitations/fallbacks are clear.

## Discovery and integrations

Keep / canonical/indexable with useful prerendered content, accurate title/description/Open Graph and sitemap inclusion from the route registry. Robots references the production sitemap. Account/staff search rules remain in the shared discovery/security plans; do not advertise /admin in crawler files.

Keep /features anchors, /pricing and /#waitlist compatibility. Verify www/trailing-slash/404 behavior, landing API exact-origin CORS/preflight, input limits and abuse controls. Keep strict CSP; review intended Cloudflare/analytics integrations individually instead of adding unsafe-inline.

Use [experience](../01-experience.md), [discovery](../02-discovery.md), [security](../03-security.md) and [delivery](../04-delivery.md) requirements. The visual remake implies no DNS/framework/provider or signup-policy changes.

## Work sequence

1. Capture current desktop/mobile baseline; validate every source-section disposition and useful part to retain.
2. Produce full-height desktop/mobile light/dark compositions; finalize hero crop, display font and all eleven sections.
3. Define tokens/components and reviewed copy/asset manifests without duplicating pricing/capability sources.
4. Implement header, hero, workflow and product proof; verify layering, layout, keyboard and crop behavior.
5. Implement stories, individual/team use, continuity and pricing preview with honest readiness labels.
6. Integrate FAQ, the single access form/legacy anchor and footer with actual API and notification states.
7. Check accessibility, motion, performance, raw HTML, discovery artifacts, CSP and actual API behavior.
8. Review in staging; release only affected components during the later implementation task, then verify live.

## Acceptance evidence

Traceability: J01 in [journeys](../07-journeys-permissions.md), V01–V07/V18/V27–V30 in [verification](../12-verification-matrix.md), plus selected-direction/content/asset gates. Every page section is required alongside shared contracts.

- Every section reviewed; no untouched repeated-card page hidden below a new hero.
- Full-height desktop/mobile light/dark captures match the selected typography, layering and business focus.
- Every CTA/anchor works, including old waitlist links; no fictitious checkout or automatic access.
- Requests tested across success/failure; human verification and notification delivery independently verified if used.
- Claims/readiness/pricing checked; screenshots genuine, current and safe for publication.
- Keyboard/focus/zoom/reduced-motion/image fallback/no-JS content and loading performance checked.
- Deployed canonical/sitemap/robots/raw HTML/CSP/CORS verified during release. Planning/local design is not reported as live completion.
