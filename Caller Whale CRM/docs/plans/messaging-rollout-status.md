# Team chat rollout: where it stands and what is left

**Written:** 2026-11-14. Continue from any machine: everything needed is in this file and in the files it links. **No secret is written here.** The three secrets are in the owner's password manager (see "Secrets").

Background: [messaging-sms-voice.md](messaging-sms-voice.md) (decisions), [messaging-sms-voice-detail.md](messaging-sms-voice-detail.md) (research, costs, risks), [coolify-setup-messaging.md](coolify-setup-messaging.md) (the setup steps this file tracks), `services/messaging/README.md` (the service).

## What exists

| Piece | Where | State |
| --- | --- | --- |
| Messaging service (Go) | `services/messaging/`, branch `messaging-backend-production` | Built, tested, **deployed and healthy** |
| Live server (Centrifugo v6) | `services/live/` (settings in `config.json`, Dockerfile, test), branch `live-backend-production`; Coolify, environment **gateway and network management**, app "Caller Whale Live Server" | **2026-11-16: moved to code and cut over.** Now built from the branch, alias `centrifugo`, **running on the Redis engine** (see "Switching the Live Server to the branch"). The old stock-image app is stopped and waits to be deleted (Coolify asks for the owner's password) |
| Messaging database | Coolify, environment **database**, "Caller Whale Messaging PostgreSQL" (PostgreSQL 17, private, SSL required) | **Running**; the service made its tables |
| Messaging Redis | Coolify, environment **database**, "Caller Whale Messaging Redis" (Valkey 9, private, no persistence, `maxmemory 200mb` with `volatile-lru`, 0.5 CPU, 256 MB, no swap) | **Running** (2026-11-16, SSL enabled). **Wired:** the live server's log shows `engine: redis`. The link is encrypted; `config.json` skips the certificate check because Coolify's own certificate authority is not trusted inside the container |
| Authorization | Existing app "Caller Whale Authorization" | Redeployed with the `messaging` caller and its token |
| Gateway routes | Existing "Caller Whale Gateway", `ROUTES` variable | `chat.callerwhale.com=http://messaging:8108,live.callerwhale.com=http://centrifugo:8000` **saved, not yet live** (needs a redeploy) |
| CRM Inbox client | `desktop/frontend/react/src/remote/messaging.ts`, `Work.jsx`, `App.jsx` | Written, 8 tests pass, **off** until the build variable below is set |

Evidence of health (2026-11-14): Messaging's runtime log shows `applied migrations/0001_messaging.sql`, "the database login is a superuser: requests run as the restricted role messaging_app so row security applies", "Listening on port 8108", and `GET /healthz 200`.

### Coolify addresses (project "Caller Whale")

- Project: `https://coolify.callerwhale.com/project/otqz9nm5wbnwil9auvml9y2q`
- Environments: backend `oci63bnjhbltllgzrapxyuan`, database `qw5frf7cksxyytctiszz4p2f`, gateway and network management `s9zexgncl1zhgtpwdr58jved`
- Messaging app: `…/environment/oci63bnjhbltllgzrapxyuan/application/zdmz5cyasx37hmuobw2vzgpn`
- Live Server app: `…/environment/s9zexgncl1zhgtpwdr58jved/application/k5lqwfwbb6jxacg3royad8ot`
- Gateway app: `…/environment/s9zexgncl1zhgtpwdr58jved/application/wigouvvmfwpdzrkqyw3marwt`
- **Live Server (the one in use)**, built from `live-backend-production`, named "Caller Whale Live Server", alias `centrifugo`, running: `…/environment/s9zexgncl1zhgtpwdr58jved/application/x37gvvpjrccr8ln9jz9v0iob`
- Old Live Server (stock image), **stopped, to delete** (the delete asks for the owner's Coolify password): `…/application/k5lqwfwbb6jxacg3royad8ot` (the Live Server line above)
- Authorization app: `…/environment/oci63bnjhbltllgzrapxyuan/application/ya2vvzhtywejtybx1rnexyvr`
- Messaging database: `…/environment/qw5frf7cksxyytctiszz4p2f/database/d5fq1zm3wxycsfnk35lz2mav`

(Add the path after the project address: `…/environment/<id>/application/<id>`.)

## Secrets (never in git)

Three random values of 64 hex characters, made once and kept in the password manager. Each is entered in two places, and the two must be identical:

| Value | Messaging variable | Other app |
| --- | --- | --- |
| A | `AUTHZ_TOKEN` | Authorization: `,messaging=<A>` appended to `AUTHZ_TOKENS` |
| B | `LIVE_API_KEY` | Live Server: `CENTRIFUGO_HTTP_API_KEY` |
| C | `LIVE_TOKEN_SECRET` | Live Server: `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY` |

Messaging's `DATABASE_URL` is the internal URL copied from the database's own page (it holds the database password Coolify generated).

To make new values in PowerShell:

```powershell
function New-Secret { $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
$A = New-Secret; $B = New-Secret; $C = New-Secret
"AUTHZ_TOKEN=$A"; "LIVE_API_KEY=$B"; "LIVE_TOKEN_SECRET=$C"
"CENTRIFUGO_HTTP_API_KEY=$B"; "CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY=$C"; ",messaging=$A"
```

Rotating one means changing it in both places and redeploying both apps.

## What is left, in order

**Done 2026-11-16: steps 1 to 4.** `chat` and `live` DNS records (A, proxied, same address as `gate`) added by the owner; both domains added to the Gateway (Coolify also auto-adds `www.` copies: delete them); `LIVE_HOST=live.callerwhale.com` set; Gateway redeployed. Outside checks passed: `chat/healthz` 200, `chat/api/v1/messaging/conversations` 401 without a token, `live/health` and `live/metrics` 404, and a WebSocket upgrade on `live/connection/websocket` answers `101 Switching Protocols` through Cloudflare and the gateway. **Left: step 5 (switch the CRM on) and step 6 (two-person test).**

### 1. Cloudflare DNS (owner)
Add two records, `chat` and `live`, with the same type, target and proxy setting as the existing `gate` record. Turn off challenges and bot protection for both hostnames (a challenge page breaks an app's requests, and `live` is a WebSocket).

### 2. Gateway domains (owner or Claude through the browser)
Gateway app → Domains: add `https://chat.callerwhale.com` and `https://live.callerwhale.com` to the existing list, comma-separated, keeping the current ones. Save.

### 3. Redeploy the gateway
Redeploy **Caller Whale Gateway**. This one redeploy applies the domains and the saved `ROUTES`. It carries all public traffic: wait for healthy; Coolify keeps the old copy until the new one passes.

### 3b. Gateway: `LIVE_HOST`
In the Gateway's variables add `LIVE_HOST=live.callerwhale.com` (it must be one of the `ROUTES` hosts) before the redeploy in step 3. The gateway then answers only `/connection/websocket` on that host: the live server's API, `/metrics` and `/health` look like nothing from outside.

### 4. Check from outside
- `https://chat.callerwhale.com/healthz` answers `{"ok":true,"service":"messaging"}`.
- `https://live.callerwhale.com/health` now answers **404** (private by design; the container's own health check uses the private address).
- The socket: the browser must be able to open `wss://live.callerwhale.com/connection/websocket`. **The gateway has never carried a WebSocket before** (`services/gateway`); if it refuses (a 400 or 426, or the connection drops at once), the fix is in the gateway's reverse proxy. Until then chat still works by the CRM asking again every 5 seconds, so a failing socket is a delay, not an outage.
- `GET https://chat.callerwhale.com/api/v1/messaging/conversations` without a token answers 401 (not a gateway 404). The gateway's path rules (`services/gateway`, the core-API classification applies only to the `CORE_HOST`) may need `chat.callerwhale.com` added if it treats unknown hosts differently: check its log.

### 5. Switch the CRM on
Only when step 4 passes. In the **frontend** environment, app `landing-dashboard-web`, add the build variable `VITE_CALLERWHALE_MESSAGING_URL=https://chat.callerwhale.com` and redeploy. (Do this last: that app rebuilds on its own on any push, and with the variable set the Inbox starts calling the chat host.) To undo: clear the variable and redeploy.

### 6. Try it for real
Sign in at `https://app.callerwhale.com` as two people of one workspace (two browsers). Inbox → New conversation → Direct message (and Group). Each should see the other's messages within a second or two (socket) or five (fallback). Check: reply, reaction, poll vote, archive, unread count, a message sent while offline showing "Not sent", someone removed from a group losing it at once.

## Known limits (not built)

- Photos, files, GIFs, locations and contacts in team chats: the app says they are not available yet.
- "Mark unread" is a reminder on one device only.
- Search, attachments, and notifications when the app is closed.
- Text threads with leads (`kind = 'lead'`) and team notes: the columns exist, the requests do not. That is the SMS stage (see the plan).
- Redis for the live server: created 2026-11-16 (variables `CENTRIFUGO_ENGINE_TYPE=redis` and `CENTRIFUGO_ENGINE_REDIS_ADDRESS`, names from third-party v6 examples: check the first start's log). It carries only live delivery, replay, and later send limits and presence; message text stays in the messaging Postgres only (row security is the one gate for content).
- GitHub Actions has been blocked by a billing error, so the `messaging` job in `.github/workflows/check-backend.yml` has never run there. Locally all 15 Go tests pass against PostgreSQL 17.

## Facts worth knowing before changing things

- **Pushing `messaging-backend-production` redeploys Messaging by itself** (Coolify webhook). Publish with `node "Caller Whale CRM/tools/publish-production.mjs" --push` as usual; Messaging redeploys only when its files change.
- **The database login is a superuser.** Row security does not apply to a superuser, so the service creates a no-login role `messaging_app` and runs every request as it, and refuses to start with a login that bypasses row security without being a superuser. Do not remove this (`services/messaging/db.go`, `restrict`).
- **The live server holds nothing.** Messages and conversations are only in the Messaging database; a Centrifugo restart loses nothing, and the app catches up by message number.
- **Messaging calls out only to the authorization service** (who is in a workspace) and the live server (private API). Sign-in tokens are checked locally from the auth service's public keys.
- Coolify's "Move resource" moved the Live Server between environments without changing its alias; environments are folders, all apps share the `coolify` Docker network.
- Local test database for the Go tests: set `MESSAGING_TEST_ADMIN_URL` (superuser) and `MESSAGING_TEST_DATABASE_URL` (ordinary login), then `go test ./...` in `services/messaging`.

## How to continue on another machine

1. Clone the repository and read this file, then `services/messaging/README.md`.
2. In Claude Code, say: "continue the team chat rollout from `Caller Whale CRM/docs/plans/messaging-rollout-status.md`, starting at step 1". Browser steps (Cloudflare, Coolify) need the Claude in Chrome extension signed in to both.
3. Secrets come from the owner's password manager. Never ask for them in chat, and never write them in a file.
4. After each step, update the "What exists" table here and push.

## Switching the Live Server to the branch

1. Publish branches (`node "Caller Whale CRM/tools/publish-production.mjs" --push`) so `live-backend-production` exists.
2. In Coolify, Live Server app: source = the repository, branch `live-backend-production`, build pack Dockerfile, base directory `/`, Dockerfile `/Dockerfile`, port 8000. Keep the alias `centrifugo`, the health check (`GET http://localhost:8000/health`, 200) and the variables. The old `CENTRIFUGO_HEALTH_ENABLED` and `CENTRIFUGO_CHANNEL_NAMESPACES` variables are now in `config.json` and can be deleted.
**Done 2026-11-16:** the app "Caller Whale Live Server (code)" exists in the same environment (made with the Docker Compose build pack, then switched to Dockerfile, because the new-app form rejects the default compose path that has spaces). Dockerfile `/Dockerfile`, base `/`, port 8000, health check `GET /health` on 8000 (start period 20 s). Its five variables are saved with **placeholders** for the API key, token secret and Redis URL (the same key and secret as the old Live Server and as messaging's `LIVE_API_KEY` / `LIVE_TOKEN_SECRET`). **No network alias yet and not deployed.**

**Cutover done 2026-11-16:** the first deploy failed on Redis ("x509: certificate signed by unknown authority"); `engine.redis.tls` (`enabled`, `insecure_skip_verify`, names read from Centrifugo v6.10.3's source) was added to `config.json`, and the next deploy started on `engine: redis` and passed its health check. The old app was stopped, the new one got the alias `centrifugo` and was redeployed, and renamed "Caller Whale Live Server". **Left for the owner:** delete the stopped old app (Danger Zone; Coolify asks for the account password). Never start it again: two apps with the alias would split connections between two engines.
Note: Coolify's own health-check line says "curl: not found" (the image has no curl) but reports healthy through the image's built-in `wget` check; harmless.
3. Paste the Redis URL (see `env/centrifugo.production.example`) and redeploy. The first build is the first time this container is built anywhere: read its build log and the Runtime Logs table.
