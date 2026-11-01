# Shared experience and visual system

Status: Proposed. Parent: [Web rebuild plan](README.md).

## Page-by-page audit first

For every existing section record: URL, screenshot, audience, job, keep/improve/remake, specific issue, proposed adjustment, mobile behavior, data source and verification. Include header/footer, images, forms, tables, errors and empty states. Do not call a whole page reviewed after checking its hero.

Use real shipped product captures, label sample workspaces as samples, and remove personal information. Do not invent customer logos, testimonials, savings, uptime, usage figures or mock product capabilities.

## Public layout

Consistent header with product navigation, sign-in and one context-appropriate primary action. Clear headline, useful product proof, honest availability and next step. Avoid repeating a waitlist form at the bottom of every public page by default: select the relevant CTA per page. Legal and auth pages should not acquire promotional sections automatically.

Footer groups product, company, legal and support links. All links have real destinations. Use native links so opening in a new tab, copying URLs and keyboard navigation work.

## Dashboard layout

Stable sidebar geometry on desktop; header holds page title, context and account controls. Overview, Usage, Downloads, Account and Security are the initial navigation items. Staff see an Enter admin mode control only after server authorization.

At narrow widths the sidebar becomes a drawer with a focus trap and clear close control. Main content keeps a readable order. Tables may scroll within their region; the whole page must not acquire accidental horizontal scrolling. Keep primary actions visible without covering content.

Use progressive disclosure. An expanded high-priority panel may collapse a lower-priority panel only in views designed for mutually exclusive expansion, with clear state, keyboard access and no lost input. Park collapsed board/panel rails at the nearest applicable edge. Do not apply automatic collapse to forms or unrelated pages.

## Foundations

Define shared tokens for color, type, spacing, content widths, radius, borders, shadows, elevation and motion. Start with a 4px spacing scale and use consistent section rhythm. Tables, forms and reading pages may use different density while sharing alignment.

Use light/dark semantic tokens, system preference on first visit, then a persisted explicit choice. Verify focus rings, disabled states, charts and validation in both themes. Aim for WCAG 2.2 AA; 44px interactive targets where practical and no target below applicable accessibility minimums.

Motion communicates opening, selection, progress and relationship. Respect reduced-motion. Avoid scroll hijacking, auto-playing background video, decorative loading delays and movement that shifts an active control.

## Shared components

Header, footer, sidebar, page heading, section heading, button/link, labeled field, password checklist, human-verification slot, alert, toast, skeleton, empty state, data table, pagination, filter, confirmation, drawer and session-expiry prompt.

For each component specify keyboard behavior, focus placement/restoration, loading, error, disabled/busy state, long text, localization and light/dark variants. Use one icon family with accessible text labels where meaning is not obvious.

## Content and interaction

One primary action per local task. Use concrete labels such as Download for Windows or Send confirmation email. Confirm consequential changes; show what changed and let the user recover when the operation supports it. Preserve form input after recoverable errors, but clear passwords/tokens when required by the flow.

Keep validation near its field and provide an error summary for long forms. Never indicate status by color alone. Format dates with a visible timezone where it matters; use server timestamps and the person's display timezone consistently.

## Acceptance

Review all pages at 360, 390, 768, 1024 and 1440px; test at 200% zoom and with long names/errors. Complete a keyboard-only journey and a screen-reader spot check. Images have explicit dimensions, suitable crops, descriptive alt text and responsive sources. There must be no placeholder links, invented statistics or unexplained capabilities.
