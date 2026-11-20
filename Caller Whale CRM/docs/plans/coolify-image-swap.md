# Moving each Coolify app to its CI image (step 48, part 2)

**Written:** 2026-11-20, from Coolify as read through Chrome (setting names, ports, network names; no secret values) and the repository.
Part 1 (grafana-proxy and alert-relay, inside the Monitoring compose) is done. This is the rest: every app that Coolify still builds
from a production branch becomes a **Docker Image** app that runs the image GitHub Actions built
(`ghcr.io/mohammed-heshammohammed/cw-<name>`), pinned by digest (D379). Coolify cannot turn an existing Git app into an image app, so each
one is a new app beside the old one; the secrets are copied by you, because Claude never handles secret values.

## Before the first app

1. **Done 2026-11-20:** CD1 (the `production` environment: you approve, admins cannot skip it, `main` only) and the variables `COOLIFY_URL` and `CALLERWHALE_MESSAGING_URL`. **Still yours:** CD2 and CD3, the Coolify API token and its `COOLIFY_TOKEN` secret. Was: CD1 to CD3 in [checks-by-hand](people-teams-chats-clients/checks-by-hand.md#step-48-coolify-runs-the-images-part-1-grafana-proxy-and-alert-relay): the `production`
   environment, the Coolify API token (`write` and `deploy`, give it access to each new app as you create it) and `COOLIFY_URL`.
2. While the packages are public nothing else is needed. Once they are private (IM1), log the server in to ghcr.io first (CD5).
3. (Done) The repository variable `CALLERWHALE_MESSAGING_URL` = `https://chat.callerwhale.com` (the CRM web app's team chat; the
   `cw-crm-web` image fails to build without it).

## For each app, in this order

Order (from the plan, cheapest first): Learning, MCP, AI Assistant, Notifications, Live Server, Billing, Authorization, Authentication,
CRM Core, Messaging, Dialer, Importing Worker, the website, the CRM web app (Dashboard), the Gateway last.

1. **The digest.** GitHub: Actions, Images, the latest run on `main`, its summary lists each image's digest. (Or Packages, `cw-<name>`,
   the newest version.) A run that built nothing for that image means the last digest is still current.
2. **New app.** Coolify, the same project and environment as the old app: New Resource, Docker Image, image
   `ghcr.io/mohammed-heshammohammed/cw-<name>@sha256:<digest>`, the Caller Whale VPS. Name it like the old one with " (image)". **Then, in its General tab, delete `@sha256` from the end of the Image field and save:** Coolify's form stores it there and again in the tag, so the first deploy fails with "invalid reference format" (seen on Learning).
3. **General.** Docker network `coolify`; Exposed ports as in the table; **leave Network aliases empty for now** (two containers with
   the same alias would share its traffic). No domain unless the table says so.
4. **Settings.** Old app, Environment Variables, Developer View: copy everything. New app, Developer View: paste, save. (Billing: drop
   the `core-api=` entry from `BILLING_TOKENS` while you are there; it is why billing is down.)
5. **Persistent storage, healthcheck, limits.** Copy the old app's Persistent Storage tab (none were found on CRM Core) and Resource
   Limits, if any. The image carries its own HEALTHCHECK.
6. **Deploy the new app** and read its runtime log: it starts, and its health check passes. Nothing reaches it yet.
7. **Switch.** Stop the old app; on the new app set Network aliases to the old alias (table) and redeploy it. For the website, the CRM
   web app and the gateway, move the domains instead (remove from the old app, add to the new, redeploy the new).
8. **Check** as in the table. If it fails: stop the new app, start the old one (its alias and domains are unchanged), and tell Claude
   what the log says.
9. **Tell Claude the new app's id** (the last part of its Coolify address). Claude adds `"deploy": {"coolify": "<id>"}` to the image in
   `tools/production.json`, so the next new image of it deploys itself after your approval. Keep the old app stopped for a week, then
   delete it; when every app of a production branch has moved, its branch is retired (D380).

| Order | Old app (id) | Image | Port | Network alias | Domains | Settings to copy (names) | Check after |
|---|---|---|---|---|---|---|---|
| 1 | **Done 2026-11-20.** Old: Caller Whale Learning (`vj0vujhfbaatothc1vwjy9w0`), stopped (delete after 2026-11-27). New: Caller Whale Learning (image) (`aglpc4qq7he7oskohr8gwo3t`), running with alias `learning`; its `deploy` entry is in `production.json` | cw-learning | 8112 | learning | none | PORT LEARNING_ENABLED LEARNING_RETENTION_DAYS DATABASE_URL LEARNING_TOKEN LEARNING_HASH_KEY | CRM Core's log shows no learning errors |
| 2 | Caller Whale MCP (`dijmk18qoh5txr02kky64inn`) | cw-mcp | 8106 | mcp | none (the gateway serves mcp.callerwhale.com) | PORT MCP_PUBLIC_URL MCP_AUTH_PUBLIC_URL MCP_AUTH_URL MCP_AUTH_TOKEN | `https://mcp.callerwhale.com` answers as before |
| 3 | Caller Whale AI Assistant (`kvrd0xwxh1yycqbrpl0rjkiw`) | cw-assistant | 8109 | assistant | none (assistant.callerwhale.com via the gateway) | PORT CORS_ORIGINS SITE_URL OPENROUTER_API_KEY OPENROUTER_MODEL ASSISTANT_MESSAGES_PER_MINUTE ASSISTANT_AI_PER_VISITOR_PER_DAY ASSISTANT_AI_PER_DAY | The website's helper chat answers |
| 4 | none today: Notifications is not deployed | cw-notifications | 8102 | notifications | none | from `env/notifications.production.example` (new values, yours) | An invitation email arrives; CRM Core's report emails stop failing |
| 5 | Caller Whale Live Server (`x37gvvpjrccr8ln9jz9v0iob`) | cw-live | 8000 | centrifugo | none (live.callerwhale.com via the gateway) | CENTRIFUGO_HTTP_API_KEY CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY CENTRIFUGO_CLIENT_ALLOWED_ORIGINS CENTRIFUGO_ENGINE_TYPE CENTRIFUGO_ENGINE_REDIS_ADDRESS | A team chat message arrives without reloading |
| 6 | Caller Whale Billing (`gmujc0jbvynmwcthpkcw2ujc`) | cw-billing | 8103 | billing | none | PORT DATABASE_URL BILLING_TOKENS PADDLE_WEBHOOK_SECRET PADDLE_WEBHOOK_TOLERANCE_SECONDS AUTHZ_URL AUTHZ_TOKEN | Billing is Running (it is down today); the plan page loads |
| 7 | Caller Whale Authorization (`ya2vvzhtywejtybx1rnexyvr`) | cw-authz | 8104 | authz | none | PORT DATABASE_URL AUTHZ_SIGNING_KEY AUTHZ_TOKENS AUTHZ_GRANT_SECONDS AUTHZ_REQUIRE_SECOND_STEP AUTHZ_STAFF_SECOND_STEP AUTHZ_PLATFORM_OWNER AUTHZ_PLATFORM_COFOUNDER AUTH_NOTIFY_TOKEN AUTH_NOTIFY_URL | Sign in and open the CRM: your leads load |
| 8 | Caller Whale Authentication (`akh3puhozfxw0nt7wbnykwvh`) | cw-auth | 8101 | auth | none (auth.callerwhale.com via the gateway) | PORT DATABASE_URL AUTH_SIGNING_KEY AUTH_PUBLIC_URL AUTH_WEBSITE_URL AUTH_APP_URL AUTH_LANDING_URL AUTH_PUBLIC_SIGNUP AUTH_DEV_TOKENS AUTH_ALLOWED_ORIGINS AUTH_FIREBASE_API_KEY AUTH_GOOGLE_CLIENT_ID AUTH_GOOGLE_CLIENT_SECRET AUTH_NOTIFY_URL AUTH_NOTIFY_TOKEN AUTH_TELEGRAM_BOT_TOKEN AUTH_TELEGRAM_BOT_NAME AUTH_TELEGRAM_WEBHOOK_SECRET AUTHZ_URL AUTHZ_TOKEN AUTH_MCP_TOKEN | Sign out and in again, with Google too |
| 9 | Caller Whale CRM Core (`v8o8l3d2lenvzsjanzg60byn`) | cw-crm-core | 8107 | crm-core | none (gate.callerwhale.com via the gateway) | PORT DATABASE_URL AUTH_JWKS_URL AUTHZ_URL AUTHZ_TOKEN NOTIFY_URL CORS_ORIGINS IMPORT_DIR IMPORT_DB_ROLE MAX_IMPORT_MB LEARNING_URL LEARNING_TOKEN DIALER_TOKEN | Leads, tasks and an upload of a small list |
| 10 | Caller Whale Messaging (`zdmz5cyasx37hmuobw2vzgpn`) | cw-messaging | 8108 | messaging | none (chat.callerwhale.com via the gateway) | PORT DATABASE_URL AUTH_JWKS_URL AUTHZ_URL AUTHZ_TOKEN CORS_ORIGINS LIVE_API_URL LIVE_API_KEY LIVE_TOKEN_SECRET LIVE_PUBLIC_URL | Team chat sends and receives |
| 11 | Caller Whale Dialer (`f2yhdiu2eg9aqwfzdapwzo1m`) | cw-dialer-sms | 8113 | dialer-sms | none | PORT AUTH_JWKS_URL AUTHZ_URL CRM_URL CORS_ORIGINS TELNYX_MODE SIM_SPEED TELNYX_CONNECTION_ID TELNYX_PUBLIC_KEY TELNYX_WEBHOOK_URL TELNYX_MESSAGING_PROFILE_ID TELNYX_SIP_CONNECTION_ID TELNYX_FROM_NUMBER TELNYX_AMD RECORD_CALLS DATABASE_URL AUTHZ_TOKEN CRM_TOKEN TELNYX_API_KEY | A simulated call is logged on the lead |
| 12 | Caller Whale Importing Worker (`lbqss8yt3jib2dcnncnodtnn`) | cw-importing-lists | 8111 | importing-lists | none | PORT DATABASE_URL IMPORT_DIR IMPORTING_CHUNK_KB | An uploaded list finishes importing |
| 13 | Caller Whale Landing Web (`vwalwgyj2vpuxlm9ljklslby`) | cw-website | 8080 | none | move callerwhale.com and www (copy its Domains tab) | none needed at run time (the address is built in); its listed build variables are not used | `https://callerwhale.com` and its sign-in page |
| 14 | Caller Whale Dashboard (`tmv1plya9wrydcohecfa2scp`) | cw-crm-web | 8080 | none | move app.callerwhale.com (copy its Domains tab) | none at run time (built in) | `https://app.callerwhale.com`, sign in, the Inbox's team chats |
| 15 | Caller Whale Gateway (`wigouvvmfwpdzrkqyw3marwt`) | cw-gateway | 8100 | gateway | move all of its domains (copy its Domains tab) | PORT ROUTES CORE_HOST AUTH_JWKS_URL STAFF_REQUIRE_SECOND_FACTOR IP_PER_MINUTE USER_PER_MINUTE MAX_BODY_MB PROXY_HOPS MONITORING_UPSTREAM HUMAN_CHECK AUTH_HOST RECAPTCHA_KIND RECAPTCHA_SITE_KEY RECAPTCHA_SECRET_KEY RECAPTCHA_FALLBACK_SITE_KEY RECAPTCHA_FALLBACK_SECRET_KEY RECAPTCHA_HOSTNAMES HUMAN_PER_MINUTE SCAN_LIMIT SCAN_WINDOW_MINUTES SCAN_PAUSE_MINUTES CORS_ORIGINS MCP_HOST LIVE_HOST | Every check above once more, through the public addresses |

## Not verified

- Coolify's API taking the digest the way its own form stores it (image `<name>@sha256`, tag `sha256-<hex>`, read from the Learning app;
  `tools/coolify-deploy.mjs` sends that). The first moved app's first automatic deploy proves it; if Coolify refuses, the deploy job fails before deploying.
- The Domains tabs could not be read (Cloudflare's check); the domains above come from the gateway's `ROUTES` and the apps' descriptions.
