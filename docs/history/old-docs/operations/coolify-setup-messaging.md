# Coolify setup: team chat (the messaging service and the live server)

**Now (2026-11-22):** carried out; messaging and the live server run. The live-delivery switch-over is in `messaging-rollout-status.md`.

**Status:** written 2026-11-14 with the code; not yet carried out. Do these in order. Secrets are typed by you in Coolify only.
Nothing changes for people using the CRM until step 7, and step 7 is undone by clearing one build setting.

## What you are creating

| # | Resource | Kind | What it is for | Public address |
| --- | --- | --- | --- | --- |
| 1 | `Caller Whale Messaging PostgreSQL` | Database (PostgreSQL 17), its own like the others | Conversations and messages | None |
| 2 | `authz` (exists) | Application | One more caller token, so messaging may ask who is in a workspace | None |
| 2b | `Caller Whale Messaging Redis` | Database (Valkey 9), its own, private, no persistence | The live server's engine (delivery and replay only, no message text) | None |
| 3 | `centrifugo` | Application (Docker image) | The live server: holds the apps' sockets | None (the gateway routes `live.callerwhale.com` to it) |
| 4 | `messaging` | Application (Dockerfile) | Team chats and groups | None (the gateway routes `chat.callerwhale.com` to it) |
| 5 | `gateway` (exists) | Application | Routes the two new addresses | existing |
| 6 | Cloudflare | DNS | `chat` and `live` | yes |
| 7 | `landing-dashboard-web` (exists) | Application | The CRM web app is told where chat is | existing |

## Three secrets to make first

Make three values of 64 random hex characters each and keep them in your password manager
(PowerShell: `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`):

- **A:** messaging's token at the authorization service.
- **B:** the live server's API key.
- **C:** the live server's token secret.


## 1. The database
Created (2026-11-14) as its own Coolify database, `Caller Whale Messaging PostgreSQL`, private, with Coolify's own generated login. Nothing to make by hand. Copy its internal connection URL into messaging's `DATABASE_URL`. The login is a superuser, which is fine: at every start the service makes a restricted role (`messaging_app`) and runs each request as it, so row security applies. Password D is not needed.

## 2. authz gets messaging's token
- First redeploy `authz` from its branch, so it knows the caller `messaging` (the code is already on `authz-backend-production`).
- Append `,messaging=<A>` to its `AUTHZ_TOKENS`, keeping the existing entries. Redeploy.

## 3. The live server
- New application from a Docker image: `centrifugo/centrifugo:v6`. Port `8000`. Network alias `centrifugo`. **No domain.**
- Environment: paste `env/centrifugo.production.example`, then fill B and C.
- Healthcheck tab: enable it, GET `http://localhost:8000/health`, port `8000`, expected code 200 (needs `CENTRIFUGO_HEALTH_ENABLED=true` above). Set up 2026-11-14 and passing.
- Deploy. Its log should say it serves on port 8000.

## 4. messaging
- New application from this repository, branch `messaging-backend-production`. Build pack Dockerfile, base directory `/`, Dockerfile `/Dockerfile`.
- Port `8108`. Network alias `messaging`. **No domain.** Health check path `/healthz`.
- Environment: paste `env/messaging.production.example`, then fill `DATABASE_URL` (password D), `AUTHZ_TOKEN` (A), `LIVE_API_KEY` (B) and `LIVE_TOKEN_SECRET` (C).
- Deploy. The log should say it applied `0001_messaging.sql`.

## 5. The gateway
- `ROUTES`: add `chat.callerwhale.com=http://messaging:8108,live.callerwhale.com=http://centrifugo:8000`.
- Add `chat.callerwhale.com` and `live.callerwhale.com` to the application's **Domains**. Redeploy.

## 6. Cloudflare
- DNS: add `chat` and `live` like the existing `gate` record (same target, proxied). WebSockets are on by default for proxied records.
- Turn off challenges for both hostnames, as for `gate`: a challenge page breaks an app's requests.

## 7. Check, then tell the CRM
- From the gateway's terminal: `wget -qO- http://messaging:8108/healthz` prints `{"ok":true,"service":"messaging"}`.
- `https://chat.callerwhale.com/healthz` answers the same from outside.
- On `landing-dashboard-web`, add the build variable `VITE_CALLERWHALE_MESSAGING_URL=https://chat.callerwhale.com` and redeploy.
- Open `https://app.callerwhale.com` as two people of one workspace: Inbox, New conversation, Direct message. Each should see the other's messages within a second or two.
- To undo: clear that build variable and redeploy. The Inbox goes back to having no team chats; nothing is lost on the server.

## Not verified
- The gateway has not carried a WebSocket to Centrifugo before; if the socket fails, chat still works by asking again every five seconds, and the cause will show in the gateway's log.
- `allow_user_limited_channels` is written from Centrifugo's documentation and has not been run.
