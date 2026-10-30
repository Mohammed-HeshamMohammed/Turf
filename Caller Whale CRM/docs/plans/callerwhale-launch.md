# callerwhale.com: sign-in, invitations, credits and the desktop download

**Status:** Built and tested locally (2026-10-29). Deploying needs the settings below.
**Replaces:** `turf.softfix.dev` as the public address. DNS state checked 2026-10-30: `callerwhale.com`, `www` and `app` answer with `187.7.72.171`; `grafana` has no record yet.

## What it does

1. **Sign in and sign up on the website** (`landing/web`): the header has **Sign in** and **Sign up**. Email and password (12+ characters, confirmed by email) or Google, through the Firebase project `callerwhale`. Signed in, the header shows **Dashboard** (invited people), **Admin** (Caller Whale's staff) and **Sign out**.
2. **Admin** (`/admin`, staff only, enforced by the core API): invite a person by email with a monthly credit limit; the invitation is emailed through the mail server (`smtp.softfix.dev`, `no-reply@softfix.dev`). The list shows everyone invited, whether they registered, how they sign in, this month's credits used against the limit, the last use and a daily chart. Staff change a limit, suspend or reactivate someone (their account is refused at once, everywhere), resend the email, or withdraw an invitation not yet accepted. Every change is in the platform activity log.
3. **Dashboard** (`/dashboard`): an invited person who signs in with the invited email (confirmed) gets their limit, usage this month by day, latest usage and the **download**. Anyone else signed in sees "Caller Whale is by invitation" and no download.
4. **The download** is the newest GitHub release tagged `crm-v*`, streamed by the core API through a link that is good for 10 minutes and only for people allowed to download. The public site no longer offers a download.
5. **The desktop app** (Full CRM, `desktop/`) cannot be used without signing in, and only an invited account gets a workspace: the first sign-in with a confirmed invited email opens that person's own workspace. Skip Tracing spends one credit per row checked, asked of the server before the check runs; when the month's credits are used up the check is refused.

Everything (invitations, people, credits, usage) is stored in the core API's PostgreSQL (migration `0014_desktop_access.sql`). Nothing is sample data.

## Where things run

| Address | Application (Coolify) | Notes |
| --- | --- | --- |
| `https://callerwhale.com` (and `www.`) | landing-web | Build args `SITE_URL=https://callerwhale.com`, `VITE_CALLERWHALE_API_URL=https://app.callerwhale.com`. Runtime env `FIREBASE_AUTH_HOST=project-34ff1df6-b240-40d4-be2.firebaseapp.com` (the Dockerfile's default), `API_ORIGIN=https://app.callerwhale.com` |
| `https://callerwhale.com/api` | landing-api | Waitlist and contact; Path prefixes: keep as-is. `CALLERWHALE_LANDING_ORIGINS=https://callerwhale.com,https://www.callerwhale.com` |
| `https://app.callerwhale.com` | core-api | Sign-in checks, invitations, credits, download. Needs PostgreSQL (project "database") |
| `https://grafana.callerwhale.com` | grafana-proxy | Staff only, reached from the admin page (Open Grafana). Set `GRAFANA_ORIGIN` on landing-web and `CALLERWHALE_GRAFANA_URL` on core-api to this address. See `deploy/grafana/README.md` |

DNS (Cloudflare, zone `callerwhale.com`): A records `@`, `www`, `app` and `grafana` to `187.7.72.171`, **DNS only** (grey cloud) so Coolify's Let's Encrypt works, as for softfix.dev. A proxied (orange) record answers 503 today because Cloudflare cannot reach a certificate for the name.

## Settings

### core-api (Coolify environment)

| Setting | Value |
| --- | --- |
| `CALLERWHALE_FIREBASE_PROJECT` | `project-34ff1df6-b240-40d4-be2` |
| `CALLERWHALE_FIREBASE_API_KEY`, `CALLERWHALE_FIREBASE_APP_ID` | from Firebase → Project settings → Your apps → Web app (public values) |
| `CALLERWHALE_FIREBASE_AUTH_DOMAIN` | `callerwhale.com` (the site serves Firebase's sign-in helper itself, see below) |
| `CALLERWHALE_FIREBASE_PROVIDERS` | `google` |
| `CALLERWHALE_ALLOWED_ORIGINS` | `https://callerwhale.com` (the site redirects `www` to it) (and `tauri://localhost,http://tauri.localhost` for the desktop app) |
| `CALLERWHALE_PUBLIC_SIGNUP` | `false` |
| `CALLERWHALE_WEBSITE_URL` | `https://callerwhale.com` |
| `CALLERWHALE_SMTP_HOST`, `CALLERWHALE_SMTP_PORT` | `smtp.softfix.dev`, `587` |
| `CALLERWHALE_SMTP_USER`, `CALLERWHALE_SMTP_PASSWORD` | `no-reply@softfix.dev` and its password (**secret**: enter it yourself) |
| `CALLERWHALE_MAIL_FROM` | `Caller Whale <no-reply@softfix.dev>` (the mail server only lets a login send as itself) |
| `CALLERWHALE_RELEASE_REPO`, `CALLERWHALE_RELEASE_TAG_PREFIX` | `Mohammed-HeshamMohammed/Turf`, `crm-v` |
| `CALLERWHALE_AUTH_JWKS_URL`, `CALLERWHALE_AUTH_PUBLIC_URL` | **remove** (or empty): the old auth service is not running, and the API refuses to start when it cannot fetch its keys |
| `CALLERWHALE_STAFF_MFA` | `true`. Staff need an authenticator code, which needs Identity Platform TOTP on the Firebase project (`tools/firebase/configure-auth.mjs`). Set `false` only until that is on |
| `DATABASE_URL`, `MIGRATION_DATABASE_URL` | from `env/database.env` |

### Firebase console (project "Caller Whale", id `project-34ff1df6-b240-40d4-be2`, owned by mgamed2002@gmail.com)

The web app is "Caller Whale Site" (app id `1:265438901851:web:5550eeb277b7135c5e717e`); its API key is on Project settings → General.

1. ~~Authentication → Sign-in method: **Email/Password** on, **Google** on.~~ Done 2026-10-29.
2. ~~Authentication → Settings → Authorized domains: add `callerwhale.com`, `www.callerwhale.com`.~~ Done 2026-10-29.
3. Google Cloud → APIs & Services → Credentials → the Web client Firebase made: add the redirect URI `https://callerwhale.com/__/auth/handler`. The site proxies `/__/auth/` to `<project>.firebaseapp.com`, so Google's redirect comes back to callerwhale.com itself and works in browsers that block other sites' storage.
4. Staff authenticator codes: Authentication → Settings → upgrade to **Identity Platform**, then put the service account key in `env/firebase.env` and run `tools/firebase/configure-auth.mjs` to turn TOTP on (`CALLERWHALE_STAFF_MFA=true` needs it).
5. For the desktop app's Google sign-in: create an OAuth client of type **Desktop app**, and add its client id under Google → Safelist client IDs.

### GitHub (Settings → Secrets and variables → Actions → Variables), for the installer

`CALLERWHALE_API_URL=https://app.callerwhale.com`, `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID`, `FIREBASE_AUTH_DOMAIN` (`<project>.firebaseapp.com`: the desktop app does not use the website's proxy), `GOOGLE_DESKTOP_CLIENT_ID`, `GOOGLE_DESKTOP_CLIENT_SECRET`. Then push a tag `crm-v0.1.0` (or run **Release the desktop app** from the Actions tab). The workflow builds the Skip Tracing engine, the app and the NSIS installer on Windows, and publishes the release.

### The first admin

After deploying, sign up on callerwhale.com with the owner's email (sign in once, so the server knows the account). The core-api image has no Python, so make that account the platform owner with SQL, once, in Coolify → database → callerwhale-postgres → Terminal:

```bash
psql -U postgres -d callerwhale
```

```sql
UPDATE users SET platform_role = 'owner', disabled_at = NULL, email_verified_at = coalesce(email_verified_at, now())
WHERE email = '<email>' AND NOT EXISTS (SELECT 1 FROM users WHERE platform_role = 'owner') RETURNING email, platform_role;
```

(`services/core-api/scripts/create_platform_owner.py` does the same from a machine with Python and the owner database URL.)

The owner can then name system administrators from the existing staff page.

## Limits of this version, honestly

- The repository is public, so GitHub's own release page lists the installer for anyone who looks there. The website only offers it to invited people, and the app itself is useless without an invited account. To hide the file too, publish releases to a private repository and set `CALLERWHALE_GITHUB_TOKEN`.
- Credits are counted by the server, but Skip Tracing runs on the person's own computer, so a modified app could skip asking. The server-side limit holds for the unmodified app.
- Only Skip Tracing spends credits today (calls are still simulated in the app). New kinds are added in `KINDS` (`routes/desktop_access.rs`) and the migration's check.
- Download links are signed with a key made when the core API starts: a restart ends the links in flight (they last 10 minutes anyway), and two copies of the API would need a shared key.
