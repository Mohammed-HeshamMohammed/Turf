# Landing dashboard web

Independent React/Vite dashboard foundation, alongside `../web` (public marketing). This scaffold does not move or replace the existing `/dashboard` in the landing site. It has no live account data, login, or API connection yet; no mock totals are presented as real. Keep existing authorized account flows in place until a separately reviewed cutover.

## Local development

Node 24 LTS recommended.

```sh
npm ci
npm run dev
npm run build
```

Development port: 5201. Production files: `dist/`.

## Coolify

Use branch `landing-dashboard-web-production`, base directory `/`, build pack **Dockerfile**, Dockerfile `/Dockerfile`, container port **8080**, health path `/healthz`. The production branch places this app at its root; its build context is the branch root. Its hostname is `app.callerwhale.com` (no `www` variant). No secrets or environment variables are required by this foundation.

Build locally: `docker build -t callerwhale-dashboard .`

Before handling customer data, implement the central auth/gateway contract, server-side authorization and the dashboard API integration. Search exclusion is not access control. Do not add secrets to Vite variables or browser code. A separate hostname needs an explicit session/CORS review; the existing plan defaults to same-origin routes.

## Publication

Source lives on `main` at `Caller Whale CRM/landing/dashboard-web`. From `Caller Whale CRM`, publish with:

```sh
node tools/publish-production.mjs landing-dashboard-web-production --push
```

Do not edit the generated production branch directly.
