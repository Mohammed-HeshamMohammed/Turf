# Coolify: public landing frontend

Deploy `landing-web-production` with the **Dockerfile** build pack:

- Base directory: `/`
- Dockerfile location: `/Dockerfile`
- Container port: `8080`
- Health path: `/healthz`
- Domain: `https://callerwhale.com` (enable HTTPS in Coolify)

The branch exports `Caller Whale CRM/landing/web` from `main` directly to its root. The Docker build context must be that root. No repository prefix or nested `landing/web` path is needed in Coolify. Re-scan the branch after its refresh and correct previously saved nested Dockerfile paths.

## Environment

Mark these public values as **build variables** in Coolify (Dockerfile ARGs):

```dotenv
SITE_URL=https://callerwhale.com
VITE_CALLERWHALE_API_URL=https://gate.callerwhale.com
VITE_CALLERWHALE_LANDING_API_URL=https://api.callerwhale.com
```

Set these as **runtime variables** for the nginx content security policy:

```dotenv
AUTH_ORIGIN=https://auth.callerwhale.com
API_ORIGIN=https://gate.callerwhale.com
LANDING_API_ORIGIN=https://api.callerwhale.com
GRAFANA_ORIGIN=https://gate.callerwhale.com
```

Use your actual deployed origins if different. Keep API build variables and runtime origins aligned. Vite variables are public; never put credentials into them. Building this frontend does not deploy its API/auth dependencies.

## Release

Edit source on `main`, verify, then run from `Caller Whale CRM`:

```sh
node tools/publish-production.mjs landing-web-production --push
```

This app's source remains separate from `landing/dashboard-web`; that app has its own production branch.
