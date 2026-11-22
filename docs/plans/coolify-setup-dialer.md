# Coolify setup: the dialer in simulate mode (Telnyx simulator, no cost)

**Status:** written 2026-11-15; the owner approved adding the dialer to Coolify in simulate mode. Do these in order. **Secrets are typed by you in Coolify only**; never paste them into a chat or a file.

In simulate mode the dialer runs a fake Telnyx inside its own container: no Telnyx account, no minutes, nothing reaches a phone. Nothing changes for people using the CRM: no screen uses the dialer yet. To undo everything: stop and delete the `dialer-sms` application and its database, clear crm-core's `DIALER_TOKEN`, and remove `dialer-sms=` from authz's `AUTHZ_TOKENS`.

Service: `services/telnyx/README.md`. Variables: `env/dialer-sms.production.example`.

## What you are creating

| # | Resource | Kind | What it is for | Public address |
| --- | --- | --- | --- | --- |
| 1 | `Caller Whale Dialer PostgreSQL` | Database (PostgreSQL 17), environment **database** | Calls, webhooks, texts, opt-outs | None |
| 2 | `authz` (exists) | Application | Knows the caller `dialer-sms` (new code) and gets its token | None |
| 3 | `crm-core` (exists) | Application | Opens its private door for the dialer (`DIALER_TOKEN`) | existing |
| 4 | `dialer-sms` | Application (Dockerfile), environment **backend** | The dialer and the simulator | None yet |

## Three secrets to make first

64 random hex characters each, kept in your password manager
(PowerShell: `$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | % { $_.ToString('x2') })`):

- **E:** the dialer's token at the authorization service.
- **F:** the dialer's token at crm-core.
- **G:** the simulator's API key (stands in for a Telnyx API key).

## 1. The database
New resource → Database → PostgreSQL 17, in the **database** environment, named `Caller Whale Dialer PostgreSQL`, not public. Start it. Its internal URL goes into the dialer's `DATABASE_URL` (step 4). The service makes its tables (schema `dialer_sms`) at start.

## 2. authz
- Redeploy `authz` from `authz-backend-production` first: the new code knows the caller `dialer-sms`. A token for an unknown caller stops authz from starting, so the code must be live before step 2b.
- Then append `,dialer-sms=<E>` to `AUTHZ_TOKENS`, keeping every existing entry. Redeploy. Check its log says it is listening.

## 3. crm-core
Add `DIALER_TOKEN=<F>`. Redeploy. (Empty or missing keeps the door shut; the rest of crm-core is unchanged.)

## 4. dialer-sms
- New application from this repository, branch `telnyx-backend-production`, **backend** environment. Build pack Dockerfile, base directory `/`, Dockerfile `/Dockerfile`.
- If **Continue** does nothing, Coolify is hiding the error "The docker compose location field format is invalid": loading the repository scans `main` and keeps its compose path (with spaces) even after the branch changes. Switch the build pack to Docker Compose, set the location to `/docker-compose.yaml`, switch back to Dockerfile, then Continue.
- Port `8113`. Network alias `dialer-sms`. **No domain** (delete the sslip address Coolify adds). Leave Coolify's Healthcheck tab off: the image is distroless (no curl or wget), and its own `HEALTHCHECK` already runs `/service health`, which checks `/healthz`.
- Done 2026-11-15: application `Caller Whale Dialer` created with the alias, no domain, and the plain variables; secrets filled by the owner; deployed and healthy (`dialer-sms:8113/healthz` answers `"carrier":"telnyx-sim"`). authz has `dialer-sms=` in `AUTHZ_TOKENS`; crm-core has `DIALER_TOKEN` (its `/internal/v1/dialer/*` answers 401 without the token, so the door is open).
- The database must actually be **started** after it is created (its first start pulls the image). A dialer started before that exits with "lookup ... server misbehaving" and Coolify removes the container; redeploy the dialer once the database runs.
- When appending to `AUTHZ_TOKENS`, paste at the very end of one line: an entry pasted into the middle of another (`core-,dialer-sms=...`) stops authz from starting ("is not one of the calling services"); Coolify then keeps the old authz running, but a restart would fail.
- Environment: paste `env/dialer-sms.production.example`, then fill `DATABASE_URL` (step 1), `AUTHZ_TOKEN` (E), `CRM_TOKEN` (F) and `TELNYX_API_KEY` (G). Keep `TELNYX_MODE=simulate`. `SIM_SPEED=10` makes a test run ten times faster.
- Deploy. The log should say it applied `0001_dialer.sql`, then `TELNYX_MODE=simulate: calls and texts go to the Telnyx simulator`.

## 5. Check
From the gateway's terminal: `wget -qO- http://dialer-sms:8113/healthz` prints `{"ok":true,"service":"dialer-sms","carrier":"telnyx-sim"}`.

## 6. Trying the scenarios (next, needs your yes)
The dialer has no public address, so the `scenarios` command on your PC cannot reach it yet. Two ways, to decide then:
- **A public address** like `dialer.callerwhale.com`: a Cloudflare record, a gateway route `dialer.callerwhale.com=http://dialer-sms:8113` and domain, and a gateway redeploy (as for chat). Then from your PC: `go run . scenarios -dialer https://dialer.callerwhale.com -token <sign-in token> -org <workspace> -lead <lead> -phone <its number> -sim-key <G>`.
- **The CRM's Calls page** calling the dialer (frontend work, not built yet), which also needs the public address.

## Going live later
Set the Telnyx values in the dialer (README, "Switching from simulate to live Telnyx"), give `/webhooks/telnyx` a public address, and redeploy. That costs money per minute and per text: decide it separately.
