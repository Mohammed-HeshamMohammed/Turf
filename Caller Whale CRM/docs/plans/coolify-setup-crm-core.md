# Coolify setup: crm-core and the import worker

Do these in order. Secrets are typed by you in Coolify only. Nothing here goes live for visitors until step 8.

## 1. CRM PostgreSQL
- New resource: PostgreSQL, name `crm-postgres`, database `crm`, private network only (no public port).
- Create two logins (Coolify's terminal for the database, or `psql`):
  - `crm_core` (owner of what crm-core creates): `CREATE ROLE crm_core LOGIN PASSWORD '<long random>'; GRANT ALL ON DATABASE crm TO crm_core;`
  - `importer`, the worker's own login: `CREATE ROLE importer LOGIN PASSWORD '<another long random>';` (crm-core gives it its tables at each start).

## 2. authz
- Add a third caller to `AUTHZ_TOKENS`: `,core-api=<64 random hex characters>`. Keep the existing `billing=` and `auth=` entries unchanged. Redeploy authz first.

## 3. Shared volume
- One persistent storage named `imports`, mounted at `/data/imports` in BOTH applications below. The folder must be writable by user id 65532.

## 4. crm-core application
- Source: this repository, branch `crm-core-backend-production`. Build pack: Dockerfile, base directory `/`, Dockerfile `/Dockerfile`.
- Port `8107`. Network alias `crm-core`. **No domain.**
- Environment: paste `env/crm-core.production.example`, then fill `DATABASE_URL` (the `crm_core` login), `AUTHZ_TOKEN` (the `core-api` token from step 2). `CORS_ORIGINS` should equal the gateway's.
- Health check path `/healthz`. Deploy. Its log should say it applied `0001_crm.sql` and `0002_importing.sql`.

## 5. Import worker application
- Branch `importing-lists-backend-production`. Dockerfile `/Dockerfile`, port `8111`, alias `importing-lists`, **no domain**.
- Environment: paste `env/importing-lists.production.example`; `DATABASE_URL` uses the `importer` login.
- Same `imports` volume at `/data/imports`.
- **Leave memory and CPU limits empty.** Deploy.

## 6. Give the worker its tables
- Restart crm-core once after the worker's login exists (step 1). It logs a warning if the login is missing; no warning means the grant worked.

## 7. Check before switching
- crm-core and the worker both show healthy.
- From the gateway's container terminal: `wget -qO- http://crm-core:8107/healthz` prints `{"ok":true,"service":"crm-core"}`.

## 8. Switch the website over
- Gateway application, `ROUTES`: change `gate.callerwhale.com=http://notifications:8102` to `gate.callerwhale.com=http://crm-core:8107`. Redeploy the gateway.
- Check `https://app.callerwhale.com`: it should open the CRM instead of "Caller Whale's server cannot be reached". Check the website's contact form still sends.
- To undo: put the old `ROUTES` value back and redeploy the gateway.
