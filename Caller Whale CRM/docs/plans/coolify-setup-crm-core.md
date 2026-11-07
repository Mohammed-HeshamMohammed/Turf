# Coolify setup: the CRM database, crm-core, the import worker and the assistant

Do these in order. Secrets are typed by you in Coolify only. Nothing reaches visitors until step 9, and step 9 can be undone.

## What you are creating

| # | Resource | Kind | What it is for | Public address |
| --- | --- | --- | --- | --- |
| 1 | `crm-postgres` | Database (PostgreSQL) | The CRM's records (leads, tasks, notes, calls, deals, handoffs) and the holding tables for uploaded lists. Two logins: `crm_core` for the backend and `importer` for the worker, which can only touch the holding tables | None |
| 2 | `authz` (exists) | Application | Gets one more caller token so crm-core may ask who can do what | None |
| 3 | `crm-core` | Application (Dockerfile) | The CRM's backend: signs people in to the CRM, syncs records, receives uploaded lists and adds them to leads | None (the gateway routes `gate.callerwhale.com` to it) |
| 4 | `importing-lists` | Application (Dockerfile) | The import worker: reads uploaded files, removes identical rows, suggests columns, cleans data, finds repeats. Idle until a list is queued | None |
| 5 | `assistant` | Application (Dockerfile) | The helper chat on the website: scripted answers plus an AI through OpenRouter, with limits. Keeps no data | None (the gateway routes `assistant.callerwhale.com` to it) |
| 6 | `imports` | Persistent storage | One shared folder where upload pieces wait, mounted at `/data/imports` in crm-core and the worker | None |
| 7 | `gateway` (exists) | Application | Routes the two new addresses to the new apps | existing |
| 8 | Cloudflare | DNS | The new address `assistant.callerwhale.com` | yes |

## 1. The CRM database
- New resource: PostgreSQL 17, name `crm-postgres`, database `crm`. **Do not make it public.**
- Open its terminal (or connect with the internal URL) and run, with two long random passwords of your own:
  ```sql
  CREATE ROLE crm_core LOGIN PASSWORD '<password A>';
  ALTER DATABASE crm OWNER TO crm_core;
  CREATE ROLE importer LOGIN PASSWORD '<password B>';
  ```
- Keep the passwords in your password manager. `crm_core` must not be a superuser: the database's row security only applies to ordinary logins.

## 2. authz gets crm-core's token
- Generate 64 random hex characters (PowerShell: `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`).
- On the `authz` application, append `,core-api=<those 64 characters>` to `AUTHZ_TOKENS`, keeping the existing `billing=` and `auth=` entries unchanged. Redeploy authz first.

## 3. The shared storage
- Create a persistent storage (volume) named `imports`. You attach it to both apps below at the same path, `/data/imports`. The folder must be writable by user id 65532.

## 4. crm-core
- New application from this repository, branch `crm-core-backend-production`. Build pack Dockerfile, base directory `/`, Dockerfile `/Dockerfile`.
- Port `8107`. Network alias `crm-core`. **No domain.** Health check path `/healthz`.
- Storage: attach `imports` at `/data/imports`.
- Environment: paste `env/crm-core.production.example`, then fill:
  - `DATABASE_URL` = `postgres://crm_core:<password A>@<crm-postgres internal host>:5432/crm?sslmode=require` (use `sslmode=disable` if the database has SSL turned off).
  - `AUTHZ_TOKEN` = the 64 characters from step 2.
  - `CORS_ORIGINS` = the same list as the gateway's.
- Deploy. The log should say it applied `0001_crm.sql` and `0002_importing.sql`.

## 5. The import worker
- New application, branch `importing-lists-backend-production`. Dockerfile `/Dockerfile`, base directory `/`.
- Port `8111`. Network alias `importing-lists`. **No domain.**
- Storage: attach the same `imports` at `/data/imports`.
- Environment: paste `env/importing-lists.production.example`, then `DATABASE_URL` = `postgres://importer:<password B>@<crm-postgres internal host>:5432/crm?sslmode=require`.
- **Leave memory and CPU limits empty.** Deploy.
- Then restart crm-core once: at each start it gives the `importer` login its tables, and it warns if that login is missing.

## 6. The assistant
- New application, branch `assistant-backend-production`. Dockerfile `/Dockerfile`, base directory `/`.
- Port `8109`. Network alias `assistant`. **No domain of its own.**
- Environment: paste `env/assistant.production.example`, then `OPENROUTER_API_KEY` (your key) and, if you like, `OPENROUTER_MODEL`. Without a key it still answers from its script.
- Deploy.

## 7. The gateway
- On the `gateway` application:
  - `ROUTES`: add `assistant.callerwhale.com=http://assistant:8109`.
  - `CORS_ORIGINS`: make sure it contains `https://callerwhale.com` and `https://app.callerwhale.com`.
  - Add `assistant.callerwhale.com` to the application's **Domains**, beside `gate`, `auth` and `mcp`.
- Do not change the `gate.callerwhale.com` route yet. Redeploy the gateway.

## 8. Cloudflare
- DNS: add `assistant` as a record like the existing `gate` and `auth` ones (same target, proxied).
- For `auth`, `gate`, `assistant` and `mcp`, turn off challenges (Security Level "Essentially off" and Bot Fight Mode off for those hostnames). The apps have their own human check and rate limits, and a challenge page breaks the sign-in for people on strict networks.

## 9. Check, then switch the website over
- crm-core, the worker and the assistant all show healthy.
- From the gateway's terminal: `wget -qO- http://crm-core:8107/healthz` prints `{"ok":true,"service":"crm-core"}`, and `wget -qO- http://assistant:8109/healthz` prints `{"ok":true,"service":"assistant"}`.
- Redeploy the landing site (`landing-web`) so it picks up the assistant. The chat button appears at the bottom right of `callerwhale.com`.
- Gateway `ROUTES`: change `gate.callerwhale.com=http://notifications:8102` to `gate.callerwhale.com=http://crm-core:8107` and redeploy the gateway. Check that `https://app.callerwhale.com` opens the CRM instead of "Caller Whale's server cannot be reached", and that the website's contact form still sends.
- To undo the switch, put the old `ROUTES` value back and redeploy the gateway.
