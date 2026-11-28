# Caller Whale VPS: deployment map and activation gates

Checked: 2 November 2026. This is a record of the current new-VPS setup, not a claim that every configured service is live.

Project: [Caller Whale in Coolify](https://coolify.callerwhale.com/project/otqz9nm5wbnwil9auvml9y2q). Server: Caller Whale VPS, 2 CPU cores, 7.8 GB RAM, Ubuntu 24.04.5 LTS. Existing GitHub App: `caller-whale-vps`.

The owner added dedicated gateway/network and monitoring environments during provisioning and approved putting their matching resources there. The project therefore has five environments, rather than the original three.

## Placement and verified state

| Environment | Resource | State at this check | Release source |
| --- | --- | --- | --- |
| frontend | Caller Whale Landing Web | Existing running service; unchanged by provisioning | `website-production` |
| frontend | Caller Whale Dashboard Web | Existing running foundation; unchanged by provisioning | `crm-web-production` |
| backend | Caller Whale Landing API | Existing running service, moved here from frontend | `landing-backend-production` |
| backend | Auth Backend | Created; build succeeded, startup failed because required reCAPTCHA keys are missing. Owner requested it stay staged | `auth-backend-production` |
| backend | Caller Whale Core API | Created and configured; stopped pending database credentials | `core-api-backend-production` |
| backend | Caller Whale Core Worker | Created and configured; stopped pending Core API and matching worker token | `core-api-backend-production` |
| backend | Caller Whale Notifications | Deployed; private `/healthz` returned HTTP 200. Email delivery is not configured/verified | `notifications-backend-production` |
| database | Caller Whale Core PostgreSQL | Running; `callerwhale` database, roles and extensions prepared | Coolify PostgreSQL 17 |
| database | Caller Whale Auth PostgreSQL | Running; `callerwhale_auth` database and role prepared | Coolify PostgreSQL 17 |
| database | Caller Whale Redis | Running privately; not yet enabled in API/worker settings | Coolify Redis 7.2 |
| gateway and network management | Caller Whale Gateway | Deployed; private `/healthz` returned HTTP 200. No public domain assigned | `gateway-backend-production` |
| monitor | Caller Whale Monitoring | Compose resource configured; stopped pending bootstrap password and working auth/Core API | `grafana-production` |

Monitoring comprises Grafana and the Grafana session proxy. A resource count is not the same as a container count. Healthy gateway/notification processes do not prove sign-in, customer data access or email delivery.

The separate billing and feature-service scaffolds were not deployed merely to make the project look populated. Their basic health/version endpoints do not provide the planned business features. Desktop applications are installed on customer devices, not deployed as VPS frontend containers.

## Resource identifiers

| Resource | Coolify identifier |
| --- | --- |
| Website | `vwalwgyj2vpuxlm9ljklslby` |
| Dashboard | `tmv1plya9wrydcohecfa2scp` |
| Landing API | `muhla4esl1lcqbdkiikdookm` |
| Auth | `akh3puhozfxw0nt7wbnykwvh` |
| Core API | `egds0b8q6ndlprigliy7oysx` |
| Core worker | `sqfo29wuhqvehvxtiikpbk2j` |
| Notifications | `vdgx3zzspaf1blp2szoxesqj` |
| Gateway | `wigouvvmfwpdzrkqyw3marwt` |
| Monitoring | `cs7nxvwhusacrlrsmolbqll9` |
| Core PostgreSQL | `rodavb3reyxdoerevgxhpsha` |
| Auth PostgreSQL | `klgh0wkss4wyxen53avjyb06` |
| Redis | `2o20dxkvkfst1nqo0emhnltl` |

Resource IDs are internal configuration references, not credentials. Recheck them after replacement or cloning.

## Image build settings

| Application | Branch build context / base directory | Dockerfile / Compose path | Internal port / alias |
| --- | --- | --- | --- |
| Auth | `/` | `/services/auth/Dockerfile` | `8101`, `auth` |
| Core API | `/` | `/services/core-api/Dockerfile` | `8088`, `core-api` |
| Core worker | `/services/core-api/go` | `/Dockerfile` | `8090`, `core-api-worker` |
| Notifications | `/services/notifications` | `/Dockerfile` | `8102`, `notifications` |
| Gateway | `/services/gateway` | `/Dockerfile` | `8100`, `gateway` |
| Monitoring | `/` | `/deploy/grafana/compose.yml` | Proxy `8120`, alias `grafana-proxy`; Grafana `3000` on its monitoring network |

Apps use the existing GitHub App and their isolated production branches. No additional deploy keys or Git credentials were created. The new gateway, notifications and database services have no public domain or host port mapping. Generated sslip.io domains were removed from the staged application resources before deployment.

The shared Coolify network permits private service-name resolution across environments. An environment is an organizational grouping, not a network isolation guarantee. Do not publish database, worker, notification or Grafana ports simply to make cross-environment connections work.

## Database preparation already completed

### CRM database

In Core PostgreSQL:

- Created `callerwhale_owner` with `NOLOGIN CREATEROLE` for database-structure work.
- Created the `callerwhale_app` group with `NOLOGIN NOBYPASSRLS`.
- Created `callerwhale_api` with `NOLOGIN NOBYPASSRLS`, a member of `callerwhale_app`.
- Granted the owner membership/admin option for the application group, as required by the existing bootstrap contract.
- Created database `callerwhale`, owned by `callerwhale_owner`.
- Installed `pgcrypto` and `citext` and granted application-group CONNECT.

### Auth database

In Auth PostgreSQL:

- Confirmed database `callerwhale_auth` exists.
- Created role `callerwhale_auth` with `NOLOGIN NOBYPASSRLS`.
- Assigned ownership of that database to the auth role.

No service-role passwords were generated or entered. These roles cannot log in until the owner sets passwords and enables login. The service-specific table structures are still applied by the relevant application's setup process after connection credentials are configured.

Never give Core API the PostgreSQL superuser or schema-owner URI as its ordinary `DATABASE_URL`: that would defeat the intended tenant row-security boundary.

## Remaining private credential setup

Enter secrets directly in Coolify or its database terminal, never in this file, Git, screenshots or chat. Browser automation cannot perform new password/credential entry on the owner's behalf.

### 1. Activate the database roles

Open the matching PostgreSQL resource's **Terminal**. Start `psql`:

```sh
psql -U postgres
```

In **Auth PostgreSQL**, run:

```text
\password callerwhale_auth
ALTER ROLE callerwhale_auth LOGIN;
\q
```

In **Core PostgreSQL**, run:

```text
\password callerwhale_owner
\password callerwhale_api
ALTER ROLE callerwhale_owner LOGIN;
ALTER ROLE callerwhale_api LOGIN;
\q
```

`\password` prompts for the chosen password without putting it into a SQL statement or this document. Set the password successfully before enabling LOGIN. Keep `callerwhale_app` NOLOGIN. These instructions apply to the already-created roles; do not repeat CREATE ROLE or recreate databases.

### 2. Set the correct database URLs

These are shapes only. Replace each password privately; URL-encode reserved characters in passwords when constructing a connection URI.

```dotenv
# Auth Backend
DATABASE_URL=postgres://callerwhale_auth:<AUTH_ROLE_PASSWORD>@klgh0wkss4wyxen53avjyb06:5432/callerwhale_auth

# Core API: separate runtime and setup identities
DATABASE_URL=postgres://callerwhale_api:<API_ROLE_PASSWORD>@rodavb3reyxdoerevgxhpsha:5432/callerwhale
DATABASE_SETUP_URL=postgres://callerwhale_owner:<OWNER_ROLE_PASSWORD>@rodavb3reyxdoerevgxhpsha:5432/callerwhale
```

The auth URL observed during provisioning still pointed at `6oj2ccetdgr1jgn6h7luiv92`, which is not one of this VPS project's database resources. Replace that old destination with the checked new auth resource and its actual role password. Do not carry over an old URI and assume it connects to a newly created container.

### 3. Bot verification now lives in the gateway (updated 2026-11-03)

The human check (Google reCAPTCHA v3) is no longer auth's job: it runs in the Go gateway in front of auth (`services/gateway/human.go`, plan in `docs/operations/bot-protection.md`). Google accepts a token once, so only one of them may check.

- **Auth:** set `AUTH_BOT_PROTECTION=false` and leave `AUTH_RECAPTCHA_*` empty. Auth then starts without keys. Delete any `AUTH_TURNSTILE_*` variables: nothing reads them.
- **Gateway:** set `HUMAN_CHECK=true`, `AUTH_HOST`, `RECAPTCHA_SITE_KEY` (the key's ID), `RECAPTCHA_SECRET_KEY` (its legacy secret key, entered privately in Coolify), `RECAPTCHA_HOSTNAMES` (`callerwhale.com,auth.callerwhale.com`) and optionally `RECAPTCHA_MIN_SCORE` and `HUMAN_PER_MINUTE`. Missing values stop the gateway from starting.
- **Network:** the public auth name (`auth.callerwhale.com`) must point at the **gateway**, which routes it to `http://auth:8101`. Auth must have no public domain of its own, or the check can be walked around.

The existing signing/Firebase credentials are preserved. Provider, email-code and redirect behavior still need end-to-end verification after deployment, and the check itself needs one real sign-in through the gateway to read Google's score.

### 4. Match service caller credentials

| Producer/consumer | Matching variables |
| --- | --- |
| Worker to Core API | Core API `CALLERWHALE_WORKER_TOKENS=worker=<TOKEN>`; worker `CALLERWHALE_WORKER_TOKEN=<same TOKEN>` |
| Auth to notifications | Notifications `NOTIFY_TOKENS` entry `auth=<TOKEN>`; auth `AUTH_NOTIFY_TOKEN=<same TOKEN>` and `AUTH_NOTIFY_URL=http://notifications:8102` |
| Core API to notifications | Notifications `NOTIFY_TOKENS` entry `core-api=<TOKEN>`; Core API `CALLERWHALE_NOTIFY_TOKEN=<same TOKEN>` |

Use strong random service tokens meeting the existing minimum lengths (at least 24 characters), entered privately. Never copy Firebase credentials into notifications, Core API, gateway or the frontends.

### 5. Finish SMTP and monitoring secrets

In Notifications, the non-secret SMTP settings are prepared for `smtp.softfix.dev:587`, login `no-reply@callerwhale.com`, sender `Caller Whale <no-reply@callerwhale.com>`. The mailbox password and notification caller tokens remain unset. The sender must be authorized by the actual mail server. A healthy notification process does not mean emails are being delivered.

In Monitoring, enter `GRAFANA_ADMIN_PASSWORD`. Keep the stack private. Its upstream is `http://core-api:8088`; the intended browser URL remains the protected gateway subpath `/staff/monitoring/`. The configured frame origin is `https://app.callerwhale.com`; an integrated and authorized Dashboard admin mode is still required there. This does not establish that the current dashboard foundation already provides that integration.

Redis is optional in the prepared Core API/worker configuration and currently disabled there. Before enabling it, use the resource's actual authenticated internal URI for Core API `REDIS_URL` and matching host/password settings for the worker. Do not expose Redis publicly or substitute an unauthenticated URL.

## Activation and cutover order

1. Complete private database-role credentials, correct connection URLs and auth CAPTCHA keys.
2. Deploy Core API with the setup and restricted runtime identities; verify structure setup and tenant-scoped access.
3. Deploy auth; verify health/JWKS, actual sign-in, verification/recovery and provider redirects.
4. Configure notification caller tokens and SMTP credentials; verify a controlled, authorized send and receipt. Then verify auth/core notification flows.
5. Set the matching worker token and deploy the worker; verify a real supported job through the private Core API.
6. Configure the Grafana bootstrap secret and deploy monitoring; verify staff authorization, fresh verification, idle/absolute expiry and direct-access denial.
7. Validate gateway authenticated behavior against those working upstreams before public DNS/domain cutover.
8. Connect the intended website/dashboard consumers only after their API/session contracts are verified.

The gateway currently has no public domain. DNS was not changed during this provisioning. Existing website/dashboard/API routing was preserved. Do not treat a successful private `/healthz` as approval to switch public traffic or a substitute for the missing auth and database checks.

## Operational notes

- Prefer sequential large Rust builds on the 2-core VPS.
- Preserve database volumes and take verified backups before a later destructive change.
- Coolify's initial repository scan retained a Compose path containing `Caller Whale CRM` from `main`. This blocked application creation with “docker compose location field format is invalid.” The production-branch scan and valid Compose path resolved it; do not deploy the main-repo scan result accidentally.
- Compose-owned literal settings can appear in Coolify's environment table. Bulk replacement can fail with “Cannot delete environment variable PORT.” Preserve managed service settings and use per-variable edits for remaining changes; a partial save must be rechecked.
- Monitoring was cloned from the gateway's credential-free configuration. Unused inherited gateway keys may remain in the Coolify environment table; the monitoring Compose file does not consume them. They do not authorize public access. Clean them up through the normal reviewed configuration workflow rather than deleting managed Compose settings.
- New application images use the [shared runtime-log standard](../operations/runtime-logs.md).

Evidence collected: Coolify resource inventory and successful gateway/notification deployment histories; read-only internal HTTP 200 probes to both services; PostgreSQL database/role bootstrap output; auth's explicit missing-CAPTCHA startup error. Actual authentication, mail delivery, CRM jobs and monitoring authorization remain activation gates, not reported successes.
