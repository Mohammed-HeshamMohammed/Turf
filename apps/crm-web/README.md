# CRM web app (app.callerwhale.com)

The same CRM as the desktop app, in the browser. There is no separate code: the screens are `apps/crm`, built with `VITE_CALLERWHALE_REQUIRE_SIGN_IN=true` so it cannot be used without signing in. This folder only packages that build: the `Dockerfile`, the nginx config, the content security policy (`scripts/security-headers.mjs`) and the log wrapper.

## Coolify

Branch `landing-dashboard-web-production`, base directory `/`, build pack **Dockerfile**, Dockerfile location `/apps/crm-web/Dockerfile`, container port **8080**, health path `/healthz`, domain `app.callerwhale.com`.

Build arguments (compiled into the page, so never secrets). The build stops if either of the first two is missing:

- `VITE_CALLERWHALE_AUTH_URL`: the auth service origin, e.g. `https://auth.callerwhale.com`
- `VITE_CALLERWHALE_API_URL`: the gateway origin the CRM calls, e.g. `https://gate.callerwhale.com`
- `VITE_CALLERWHALE_SITE_URL` (optional): defaults to `https://callerwhale.com`

On the auth service, `AUTH_APP_URL=https://app.callerwhale.com` and `https://app.callerwhale.com` in `AUTH_ALLOWED_ORIGINS`; on the gateway, the same origin in `CORS_ORIGINS`.

Local check: from the repository root (`Caller Whale CRM`), `docker build -f apps/crm-web/Dockerfile --build-arg VITE_CALLERWHALE_AUTH_URL=https://auth.callerwhale.com --build-arg VITE_CALLERWHALE_API_URL=https://gate.callerwhale.com .` (the production branch has the same layout).

## Publication

```sh
node tools/publish-production.mjs landing-dashboard-web-production --push
```

Do not edit the generated production branch directly.
