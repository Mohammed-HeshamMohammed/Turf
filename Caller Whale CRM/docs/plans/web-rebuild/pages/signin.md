# Sign in

Status: Proposed; planning only. Parent: [Web rebuild plan](../README.md).
Route/state: /signin.

## Job

Complete authentication and land the person in the right allowed place.

## Section plan

1. Recognizable compact account shell.
2. Google/Apple availability based on central provider configuration.
3. Email/password with reveal control and forgot-password link.
4. Conditional human verification.
5. Second-step challenge and recovery/error states.

## Actions and behavior

Primary: sign in. Provider starts use auth; disabled/unconfigured providers explain availability rather than pretend a flow succeeded. Allowlisted local next only.

## Layout and design

Follow the [selected direction](../05-selected-direction.md): a narrow residential architecture panel with concise return-to-work copy beside a calm ivory form, condensed display heading, readable fields, low-radius controls and peach action. On mobile prioritize the form and remove/shorten the decorative panel. Email-first is a sequencing concept, not implemented passwordless access or permission to change auth policy.

Keep button hierarchy calm; do not add unrelated promotional panels. Preserve email on failure. Model callback pending, challenge, wrong account, expired session, rate limit and offline separately.
Apply [shared experience rules](../01-experience.md), including light/dark, keyboard access and responsive review.

## Discovery and data protection

Noindex in initial HTML/header; never sitemap. Scrub provider callback code immediately and exclude account URLs from telemetry.
Apply [discovery](../02-discovery.md) and [security](../03-security.md) contracts.

## Page acceptance

Exercise email and each configured provider through auth, exchange, refresh, gateway preflight and /account. Callback exchange is single-use/deduplicated. Success returns to a valid requested page or dashboard.
Record desktop/mobile light/dark evidence and loading, empty, success and failure states as applicable. Mark unsupported states explicitly rather than silently omit them.
