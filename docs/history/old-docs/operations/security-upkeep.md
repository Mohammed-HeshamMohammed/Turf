# Security upkeep

Build step 43 of the people, teams, chats and clients plan (D304-D307). Written 2026-11-18.

## Library weaknesses (D307)

GitHub reported 11 open alerts on 2026-11-18 (4 high). Fixed in this step:

| Alert | Where | Fix |
|---|---|---|
| dnspython: excessive memory and CPU use (high) | `engines/skip-engine/requirements.txt` | 2.9.0 → 2.9.2 |
| happy-dom: SSRF, and code execution through an import alias (two, high; test tool only) | `apps/lists-desktop` | 20.14 → 21.0.4 |
| minimatch: denial of service (three, medium; build tools) | `apps/lists-desktop`, the CRM web app, `tools/firebase` | `overrides` to 11.0.9 |
| glob: post-timeout filesystem traversal (medium) | `tools/firebase` | `overrides` to 14.0.6 |
| fast-xml-parser: quadratic CPU (low) | `tools/firebase` | `overrides` to 5.12.1 |

Left, with the reason:

| Alert | Why it stays |
|---|---|
| picomatch ReDoS (high) | GitHub withdrew the advisory: there is nothing to fix. Dismiss it on GitHub as "inaccurate". |
| glib `VariantStrIter` unsoundness (two, medium) | It comes in through the desktop window library (GTK, Linux only); the fix is glib 0.20, which needs the desktop app's Tauri and GTK libraries moved up together. Do it with the next desktop upgrade; no Caller Whale code calls that iterator. |

All the apps' tests, the CRM web app's build and the old app's lint pass with the updates.

## The monthly update review (D307)

Dependabot (`.github/dependabot.yml`) now opens one pull request a month per ecosystem and folder (every Go service, npm app,
Python service, Rust workspace, Dockerfile and workflow), and GitHub opens security updates at once. On the first Monday of each month:

1. Open GitHub → Security → Dependabot alerts. Anything high or critical in what ships is fixed within a week; note the rest here
   with a reason, as above.
2. Merge the monthly pull requests whose checks pass; for a major update read its notes first.
3. Look at the latest run of the "Dependency audit" workflow (it runs daily); it is green when nothing that ships is affected.
4. Write the date and anything left in the table below.

| Review | By | Left open, and why |
|---|---|---|
| 2026-11-18 | step 43 | picomatch (withdrawn), glib (desktop upgrade) |

## Agencies stay apart: tested on every change (D305)

`services/crm-core/isolation_test.go` runs with the CRM's tests on every change (`.github/workflows/ci.yml`):

- Every CRM table with an agency's rows must be under forced row security, or be on a short list of tables meant to hold several
  agencies' rows (each says why in its migration). A new table that forgets row security fails the build.
- Signed in as another agency's owner, it calls every route the CRM registers (202 today, read from the code, so a new route is
  covered without anyone adding it) with every id the first agency has, and fails if any answer shows that agency's lead, phone,
  email, client, note, task, file or form, or if anything of theirs changed. A control shows the first agency does see its data.

`services/telnyx/isolation_test.go` does the same for the dialer's calls and texts (every route, every id), and the
messaging service's tests check chats (`services/messaging/chat_test.go`).
The production branches should only be published from a `main` whose checks are green.

## Changing secrets (D306)

Every secret is entered in Coolify only. Change each **once a year** (each November), and **at once** if someone who knew it
leaves or it may have leaked. Generate new values with `openssl rand -hex 32` unless noted. The full list, with what each is for,
is `env/container-notes.json` (`node tools/env-notes.mjs render <container>`).

**Tokens between two services** (`AUTHZ_TOKENS`/`AUTHZ_TOKEN`, `BILLING_TOKENS`/`BILLING_TOKEN`, `NOTIFY_TOKENS`/
`NOTIFY_MAIL_TOKEN`/`AUTH_NOTIFY_TOKEN`, `AGENT_TOKEN`/`ASSISTANT_TOKEN`, `AUTH_MCP_TOKEN`/`MCP_AUTH_TOKEN`, the gateway's
`AUTHZ_TOKEN`). The receiving list may hold a name twice while it changes:
1. On the receiver add the new one beside the old (`dialer-sms=<old>,dialer-sms=<new>`); redeploy it.
2. On the caller set the new one; redeploy it.
3. On the receiver remove the old one; redeploy it.

**Single tokens on both sides** (`DIALER_TOKEN` on crm-core with `CRM_TOKEN` on the dialer; `RELAY_TOKEN` on the monitoring
resource; `LIVE_API_KEY`/`CENTRIFUGO_HTTP_API_KEY`; `LIVE_TOKEN_SECRET`/`CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY`;
`LIVE_DB_PASSWORD`/the password inside `CENTRIFUGO_CONSUMERS_MESSAGING_POSTGRESQL_DSN`): set both at
a quiet hour and redeploy both together; calls between them fail for the minute in between. Changing the live server's token
secret makes every open chat reconnect.

**Signing keys** (`AUTH_SIGNING_KEY` from `/service new-key`, `AUTHZ_SIGNING_KEY`): change at a quiet hour; tokens signed with
the old key stop working, so people sign in again.

**Encryption key** `GOOGLE_TOKEN_KEY` (32 random bytes, `openssl rand -base64 32`): the stored Google connections cannot be read
after a change, so each person connects Google Calendar again. Change it only yearly or after a leak.

**Database logins** (each `DATABASE_URL`, `REDIS_PASSWORD`): change the password in the database (`ALTER ROLE … PASSWORD …`, or
Coolify's database settings), then the URL in every service that uses it, and redeploy them.

**Outside accounts**: make a new key in the provider's console, set it, redeploy, then delete the old key there: Telnyx
(`TELNYX_API_KEY`), Amazon (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), Google (`GOOGLE_CLIENT_SECRET`,
`AUTH_GOOGLE_CLIENT_SECRET`), Apple (`AUTH_APPLE_PRIVATE_KEY`), OpenRouter (`OPENROUTER_API_KEY`), Paddle
(`PADDLE_WEBHOOK_SECRET`), reCAPTCHA, Telegram (`AUTH_TELEGRAM_BOT_TOKEN`, `AUTH_TELEGRAM_WEBHOOK_SECRET`), SMTP
(`NOTIFY_SMTP_PASSWORD`), the backup bucket's key, and the ntfy topics (`PUSH_TARGETS`: pick new topics, resubscribe both phones).

| Last yearly change | By | Notes |
|---|---|---|
| — | — | First change due November 2027, or at once on a leak |

## The outside security test (D304)

Before any real agency joins, an outside tester checks, at least: sign-in (passwords, second step, Google/Microsoft/Apple,
sessions, reset and its support path), the separation between agencies (the CRM's routes, files and shared links, the dialer,
chats, exports, the tools keys), personal chats, the gateway (what is open without sign-in, the per-address limits, the human
check, the monitoring path) and the website's dashboards. Give them two throwaway agencies and a staff account with the second
step, on the live site at a quiet time. What they find is fixed before opening, and the report kept with this file.
