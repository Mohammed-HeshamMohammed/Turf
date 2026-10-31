# callerwhale.com: sign-in, invitations, credits and the desktop download

**Status:** Built and tested locally (2026-10-29). Deploying needs the settings below.
**Replaces:** `turf.softfix.dev` as the public address. DNS state checked 2026-10-30: `callerwhale.com`, `www` and `app` answer with `187.7.72.171`; `grafana` has no record yet.

## What it does

1. **Sign in and sign up on the website** (`landing/web`): the header has **Sign in** and **Sign up**. Email and password (12+ characters, confirmed by email) or Google, through the auth service (`auth.callerwhale.com`).
2. **Admin** (`/admin`, staff only, enforced by the core API): invite a person by email with a monthly credit limit; the invitation is emailed through the mail server (`smtp.softfix.dev`, `no-reply@softfix.dev`). The list shows everyone invited, whether they registered, how they sign in, this month's credits used against the limit, the last use and a daily chart. Staff change a limit, suspend or reactivate someone (their account is refused at once, everywhere), resend the email, or withdraw an invitation not yet accepted. Every change is in the platform activity log.
3. **Dashboard** (`/dashboard`): an invited person who signs in with the invited email (confirmed) gets their limit, usage this month by day, latest usage and the **download**. Anyone else signed in sees "Caller Whale is by invitation" and no download.
4. **The download** is the newest GitHub release tagged `crm-v*`, streamed by the core API through a link that is good for 10 minutes and only for people allowed to download. The public site no longer offers a download.
5. **The desktop app** (Full CRM, `desktop/`) cannot be used without signing in, and only an invited account gets a workspace: the first sign-in with a confirmed invited email opens that person's own workspace. Skip Tracing spends one credit per row checked, asked of the server before the check runs; when the month's credits are used up the check is refused.

Everything (invitations, people, credits, usage) is stored in the core API's PostgreSQL (database update `0014_desktop_access.sql`). Nothing is sample data.

## Where things run

| Container (Coolify) | Address | Port | What it is |
| --- | --- | --- | --- |
| landing-web | `https://callerwhale.com` | 8080 | The public site (static). Build and runtime settings: `env/landing-web.production.example` |
| landing-api | `https://api.callerwhale.com` | 8095 | Waitlist and contact (`/waitlist`, `/contact`), no path prefix |
| gateway | `https://gate.callerwhale.com` | 8100 | The front door for the CRM's API and the staff monitoring page (`/staff/monitoring`); routes to core-api (docs/plans/gateway.md) |
| core-api | `https://appapi.callerwhale.com` | 8088 | The CRM's API: sign-in checks, invitations, credits, the download. Needs PostgreSQL |
| core-api-worker | `https://appapiw.callerwhale.com` | 8090 | The job worker; the address only serves its health page |
| auth | `https://auth.callerwhale.com` | 8101 | Sign-in and the second step; the only part that talks to Firebase |
| notifications | `https://notify.callerwhale.com` | 8102 | Notifications |

DNS (Cloudflare, zone `callerwhale.com`): exactly seven A records, `@`, `api`, `gate`, `appapi`, `appapiw`, `auth` and `notify`, all to `187.7.72.171`, **DNS only** (grey cloud) so Coolify's Let's Encrypt works. No address is written in any code or image: each one is a setting in the container's environment, and the examples are in `env/*.production.example`.

## Settings

### core-api (Coolify environment)

| Setting | Value |
| --- | --- |
| `CALLERWHALE_AUTH_JWKS_URL` | `https://auth.callerwhale.com/.well-known/jwks.json` (the only sign-in setting: the core API knows no Firebase) |
| `CALLERWHALE_AUTH_PUBLIC_URL` | `https://auth.callerwhale.com` |
| `CALLERWHALE_ALLOWED_ORIGINS` | `https://callerwhale.com` (the site redirects `www` to it) (and `tauri://localhost,http://tauri.localhost` for the desktop app) |
| `CALLERWHALE_PUBLIC_SIGNUP` | `false` |
| `CALLERWHALE_WEBSITE_URL` | `https://callerwhale.com` |
| `CALLERWHALE_SMTP_HOST`, `CALLERWHALE_SMTP_PORT` | `smtp.softfix.dev`, `587` |
| `CALLERWHALE_SMTP_USER`, `CALLERWHALE_SMTP_PASSWORD` | `no-reply@softfix.dev` and its password (**secret**: enter it yourself) |
| `CALLERWHALE_MAIL_FROM` | `Caller Whale <no-reply@softfix.dev>` (the mail server only lets a login send as itself) |
| `CALLERWHALE_RELEASE_REPO`, `CALLERWHALE_RELEASE_TAG_PREFIX` | `Mohammed-HeshamMohammed/Turf`, `crm-v` |
| `CALLERWHALE_STAFF_MFA` | `true`. Staff need an authenticator code, which needs Identity Platform TOTP on the Firebase project (`tools/firebase/configure-auth.mjs`). Set `false` only until that is on |
| `DATABASE_URL`, `DATABASE_SETUP_URL` | from `env/database.env` |

### Firebase console

Only the auth service uses it. The one-time setup and where each setting goes are in `docs/plans/firebase-auth.md`: Email/Password and Google on, Identity Platform with authenticator codes, the Web API key into `AUTH_FIREBASE_API_KEY`, and the Google redirect `https://auth.callerwhale.com/v1/oauth/google/callback`.

### GitHub (Settings → Secrets and variables → Actions → Variables), for the installer

`CALLERWHALE_API_URL=https://gate.callerwhale.com` and `CALLERWHALE_AUTH_URL=https://auth.callerwhale.com`. Nothing else: the installer holds no sign-in provider settings.

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
- Only Skip Tracing spends credits today (calls are still simulated in the app). New kinds are added in `KINDS` (`routes/desktop_access.rs`) and the database update's check.
- Download links are signed with a key made when the core API starts: a restart ends the links in flight (they last 10 minutes anyway), and two copies of the API would need a shared key.
