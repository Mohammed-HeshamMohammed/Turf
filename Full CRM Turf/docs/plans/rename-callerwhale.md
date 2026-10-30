# Renaming Turf to Caller Whale

**Status:** code and docs done (2026-10-30). Coolify and Cloudflare clean-up is a separate list below.

## Renamed

| What | From | To |
| --- | --- | --- |
| Desktop app and installer | `Turf Full CRM` | `Caller Whale` (`Caller Whale_<version>_x64-setup.exe`) |
| App identifier | `local.turf.fullcrm` | `com.callerwhale.crm` |
| Settings (env variables) | `TURF_*`, `VITE_TURF_*` | `CALLERWHALE_*`, `VITE_CALLERWHALE_*` |
| Docs, comments and messages | "Turf" | "Caller Whale" |
| Kubernetes namespace, labels, image names; compose project | `turf…` | `callerwhale…` |

**Old settings still work.** The core API, the worker, the landing API and the Grafana proxy read `CALLERWHALE_X` first and fall back to `TURF_X`, so a server configured with the old names keeps running until its settings are renamed. The release workflow reads `vars.CALLERWHALE_API_URL`, else `vars.TURF_API_URL`.

**The installer is a new app.** Because the identifier changed, the first Caller Whale release installs next to Turf Full CRM and starts without its local data (the updater feed and signing key are unchanged). Uninstall the old one afterwards.

## Kept on purpose

These are stored or on the wire, and renaming them would break data or older clients:

- Database names, roles and functions (`turf_auth`, `turf_api`, `turf_org`, `turf_owner`, …), and the migrations that create them.
- The artifacts folder `/var/lib/turf/artifacts` (files already stored there).
- The WebSocket subprotocol `turf.v1`, the `x-turf-org` header, and the browser storage keys `turf.*`.
- Cargo crate, Go module and npm package names (`turf-api`, `turf-auth-verify`, `turf/gateway`, …), the `turf_service` Python package and the `Turf/` folder of the original app.
- The repository folder `Full CRM Turf/`, the GitHub repository name and `turf` in the legacy `turf_grouping.h` header.

## Still to do by hand

- **Coolify:** rename each application's `TURF_*` variables to `CALLERWHALE_*` (optional, the fallback covers them); set the gateway's variables and domains (docs/plans/gateway.md); remove `app.turf.softfix.dev`, `api.turf.softfix.dev` and the sslip.io domains.
- **Cloudflare, `softfix.dev` zone:** delete the `turf` and `*.turf` A records once nothing uses the old names. Keep `smtp`, `inbox` and the DKIM, SPF and DMARC records.
- **GitHub:** add the repository variable `CALLERWHALE_API_URL` (the workflow falls back to `TURF_API_URL`), and optionally rename the repository, then update `CALLERWHALE_RELEASE_REPO` and the updater endpoint in `tauri.conf.json`.
