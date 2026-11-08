# Human verification

Two layers, each doing one job.

1. **Cloudflare, at the front door (callerwhale.com).** Cloudflare looks at every visit to the site. A person who behaves like a person is let straight in and sees nothing. Only a visit that looks automated is challenged (a Managed Challenge rule). It protects the whole site and costs real visitors nothing. This is set in Cloudflare, not in code. **Set up 2026-11-01:** custom rule "Site entrance: challenge suspicious visitors" (Security rules, free plan), action Managed Challenge, for `(http.host in {"callerwhale.com" "www.callerwhale.com"} and cf.threat_score gt 10 and not cf.client.bot)`. Only the two site names are covered, so `auth`, `gate` and the other API names are never challenged. After deploying, the site, the www redirect, `auth` and `gate` still answered normally. Not yet tried from a suspicious address, so the challenge itself is unproven.
2. **Google reCAPTCHA v3, in the gateway (Go), in front of auth.** (Moved there on 2026-11-03: the gateway is the one place every public request passes, and payments will use the same check. The sections below that say "auth verifies" describe the Rust auth's built-in check, which stays only until the Go auth replaces it; run it with `AUTH_BOT_PROTECTION=false` once the gateway check is on, because a token works once.) Invisible: nobody ticks a box. Google scores each sign-in, sign-up and Google/Apple start from 0 (bot) to 1 (human), and auth refuses a score below a limit (default 0.5). So the human check is never "enforced" on a person who acts like one; it only refuses what looks like a bot.

Auth alone verifies reCAPTCHA tokens. Off by default. Set AUTH_BOT_PROTECTION=true only after entering real AUTH_RECAPTCHA_SITE_KEY and AUTH_RECAPTCHA_SECRET_KEY. Missing keys prevent startup. Never expose the secret key.

GET /v1/security publicly returns bot_protection {enabled,site_key} and password_policy {minimum:8,maximum:4096,uppercase:true,lowercase:true,number:true,special:true}. Disabled site_key is an empty string.

Frontend contract: include human_token:string in SignUp (POST /v1/accounts) and SignIn (POST /v1/sessions). The token's action must be signup or signin respectively. The page loads Google's script when it opens and asks for a new token at the moment each request is sent (`humanToken(getAuth, action)` in human-check.jsx), because Google accepts a token once: a token kept from earlier made every second try, and the Google button on the first sign-up step (which had no token at all), fail with "Verify you are human". All password submissions, including legacy code submissions, are checked; sending an empty or arbitrary code cannot bypass verification. Challenge-based /v1/mfa responses retain their existing authentication checks and do not repeat the first-leg check.

The backend posts to the fixed HTTPS Google siteverify endpoint (`https://www.google.com/recaptcha/api/siteverify`) with an eight-second timeout and no redirects. Tokens must be nonblank and at most 2048 bytes. Failure, timeout, wrong action, hostname mismatch or a score below AUTH_RECAPTCHA_MIN_SCORE returns 403 with code human_required. No user-supplied IP is trusted or forwarded. Google handles token expiry and replay rejection; every submission is verified remotely.

AUTH_RECAPTCHA_HOSTNAMES optionally supplies exact comma-separated hostnames. Otherwise auth derives them from AUTH_ALLOWED_ORIGINS and configured public, website, landing and app URLs. List the same domains on the reCAPTCHA key. The desktop app never runs reCAPTCHA itself (its window is `tauri.localhost` on Windows, which is not a real domain, and reCAPTCHA does not work on `tauri://` at all). It signs in through the person's browser instead, see "Desktop sign-in" below, so only real domains are ever on the key. Do not use dummy keys or enable live protection before frontend support is deployed.

The website and desktop share `services/auth/clients/human-check.jsx`, synchronized with the auth client. POST /v1/oauth/{provider}/start accepts {target,port,human_token,action} and returns {url}; GET provider starts are refused while protection is enabled, preventing a direct-address bypass. The parent CSP permits only Google's reCAPTCHA origins (`www.google.com/recaptcha`, `www.gstatic.com/recaptcha`) for this external script/frame. The page shows Google's required notice in small print instead of the floating badge.

Setup still to do, by the owner:
- Create a reCAPTCHA **v3** key at google.com/recaptcha/admin with `callerwhale.com` (this covers its subdomains; add `auth.callerwhale.com` only if the key asks for exact names). Do not add `tauri.localhost`. Put the site key and secret into the auth container only (secret never in GitHub, build variables, source or chat), set AUTH_BOT_PROTECTION=true, redeploy.
- A new key and code alone do not prove live verification: try a real sign-in and read the score Google returns.

## The check in the gateway

`services/gateway/human.go`. Settings are in `env/gateway.env.example` (`HUMAN_CHECK`, `AUTH_HOST`, `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`, `RECAPTCHA_HOSTNAMES`, `RECAPTCHA_MIN_SCORE`, `HUMAN_PER_MINUTE`). Guarded requests, all on the auth host:

| Request | Action Google must report |
| --- | --- |
| `POST /v1/accounts` | `signup` |
| `POST /v1/sessions` | `signin` |
| `POST /v1/oauth/{provider}/start` | `signin` or `signup`, as the body says (default `signin`) |
| `GET /v1/oauth/{provider}/start` | refused: an address cannot carry a token |

The token is the body's `human_token`. A good token must also come from one of `RECAPTCHA_HOSTNAMES` and score at least the minimum. Everything else, including Google not answering, is a 403 `human_required`, and nothing reaches auth. Each address may make `HUMAN_PER_MINUTE` guarded requests a minute, counted before Google is asked. The browser's preflight for the two website forms is answered by the gateway itself, for the origins in `CORS_ORIGINS`, so the form does not depend on the service behind having the same list. `GET /v1/security` is edited on the way out so the pages learn the check is on and which site key to use. Auth must not be reachable except through the gateway.

## The visible box ("I'm not a robot")

Added 2026-11-08 at the owner's request: people should see a check, not only the small reCAPTCHA notice. `RECAPTCHA_KIND` on the gateway picks the kind:

- `checkbox`: Google's reCAPTCHA **v2** "I'm not a robot" box. The person ticks it (Google sometimes asks for pictures as well). Needs a **v2 Checkbox** key; Google's answer for it has no score and no action, so the gateway checks only that Google accepts the token and that it came from one of `RECAPTCHA_HOSTNAMES`.
- `score` (the default): the invisible v3 check described above. Needs a v3 key.

A key of the other kind is refused with a line in the gateway log that says so. `/v1/security` tells the pages the kind (`bot_protection.kind`). With the box, the sign-in, sign-up (both steps), contact page and the CRM web app's sign-in draw it above their buttons; a request sent without a tick says "Tick “I'm not a robot” first." and sends nothing, and each request uses up the tick, so a second try needs a new one.

To switch production to the box:
1. At google.com/recaptcha/admin, create a key: reCAPTCHA **v2**, **"I'm not a robot" Checkbox**, domain `callerwhale.com`.
2. In Coolify, on the **gateway**: `RECAPTCHA_KIND=checkbox`, `RECAPTCHA_SITE_KEY` = the new site key, `RECAPTCHA_SECRET_KEY` = the new secret key (privately, never in GitHub or chat). Leave `RECAPTCHA_HOSTNAMES=callerwhale.com,auth.callerwhale.com`. Redeploy the gateway.
3. Going back is the same with `RECAPTCHA_KIND=score` and the v3 keys.

Tried locally with Google's published v2 test keys against the real gateway: no tick is refused on the page; a tick passes Google and the gateway and reaches auth; after each try the box is cleared. (The test key reports the site `testkey.google.com`, so that name had to be in `RECAPTCHA_HOSTNAMES` for the test; a real key reports `callerwhale.com`.)

## Desktop sign-in

The desktop app has no password form and no human check of its own. "Sign in with your browser" does this:

1. The window starts a listener on `127.0.0.1` (a free port, this computer only) and makes a random `state`.
2. It opens `https://callerwhale.com/desktop-sign-in?port=<port>&state=<state>` in the person's default browser (`VITE_CALLERWHALE_SITE_URL` changes the site for a test build).
3. On that page the person signs in the normal way: password, second step, Google or Apple, and the reCAPTCHA check on the real domain. The page accepts only a port from 1024 to 65535 and a 16 to 64 character `state`; anything else shows "Start from the app".
4. Signed in, the page asks the person to press **Continue to the app**, then calls `POST /v1/handoffs` with the browser's access token. Auth answers with a one-time code (two minutes, works once, stored hashed in `oauth_handoffs`) and records whether that browser session passed the second step.
5. The page sends the browser to `http://127.0.0.1:<port>/callerwhale-sign-in?code=...&state=...`. The listener hands both to the window, which checks `state`, then trades the code at `POST /v1/oauth/exchange` for its own `desktop` session. The browser's session is left as it is.

A session handed over without the second step asks for it in the app, as a Google sign-in does. The token never travels in an address, only the one-time code, and only to this computer.
