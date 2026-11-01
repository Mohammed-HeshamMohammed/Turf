# Human verification

Two layers, each doing one job.

1. **Cloudflare, at the front door (callerwhale.com).** Cloudflare looks at every visit to the site. A person who behaves like a person is let straight in and sees nothing. Only a visit that looks automated is challenged (a Managed Challenge rule). It protects the whole site and costs real visitors nothing. This is set in Cloudflare, not in code. **Set up 2026-11-01:** custom rule "Site entrance: challenge suspicious visitors" (Security rules, free plan), action Managed Challenge, for `(http.host in {"callerwhale.com" "www.callerwhale.com"} and cf.threat_score gt 10 and not cf.client.bot)`. Only the two site names are covered, so `auth`, `gate` and the other API names are never challenged. After deploying, the site, the www redirect, `auth` and `gate` still answered normally. Not yet tried from a suspicious address, so the challenge itself is unproven.
2. **Google reCAPTCHA v3, inside the service (auth).** Invisible: nobody ticks a box. Google scores each sign-in, sign-up and Google/Apple start from 0 (bot) to 1 (human), and auth refuses a score below a limit (default 0.5). So the human check is never "enforced" on a person who acts like one; it only refuses what looks like a bot.

Auth alone verifies reCAPTCHA tokens. Off by default. Set AUTH_BOT_PROTECTION=true only after entering real AUTH_RECAPTCHA_SITE_KEY and AUTH_RECAPTCHA_SECRET_KEY. Missing keys prevent startup. Never expose the secret key.

GET /v1/security publicly returns bot_protection {enabled,site_key} and password_policy {minimum:8,maximum:4096,uppercase:true,lowercase:true,number:true,special:true}. Disabled site_key is an empty string.

Frontend contract: include human_token:string in SignUp (POST /v1/accounts) and SignIn (POST /v1/sessions). The token's action must be signup or signin respectively. The client asks Google for a token when the page opens, again every 90 seconds (tokens last 2 minutes) and again after each submission. All password submissions, including legacy code submissions, are checked; sending an empty or arbitrary code cannot bypass verification. Challenge-based /v1/mfa responses retain their existing authentication checks and do not repeat the first-leg check.

The backend posts to the fixed HTTPS Google siteverify endpoint (`https://www.google.com/recaptcha/api/siteverify`) with an eight-second timeout and no redirects. Tokens must be nonblank and at most 2048 bytes. Failure, timeout, wrong action, hostname mismatch or a score below AUTH_RECAPTCHA_MIN_SCORE returns 403 with code human_required. No user-supplied IP is trusted or forwarded. Google handles token expiry and replay rejection; every submission is verified remotely.

AUTH_RECAPTCHA_HOSTNAMES optionally supplies exact comma-separated hostnames. Otherwise auth derives them from AUTH_ALLOWED_ORIGINS and configured public, website, landing and app URLs. List the same domains on the reCAPTCHA key. Windows desktop HTTP webviews may explicitly allow tauri.localhost using AUTH_RECAPTCHA_HOSTNAMES (include the web hostnames too). reCAPTCHA on tauri:// origins is unsupported; a future macOS flow needs a supported HTTPS browser handoff. Do not use dummy keys or enable live protection before frontend support is deployed.

The website and desktop share `services/auth/clients/human-check.jsx`, synchronized with the auth client. POST /v1/oauth/{provider}/start accepts {target,port,human_token,action} and returns {url}; GET provider starts are refused while protection is enabled, preventing a direct-address bypass. The parent CSP permits only Google's reCAPTCHA origins (`www.google.com/recaptcha`, `www.gstatic.com/recaptcha`) for this external script/frame. The page shows Google's required notice in small print instead of the floating badge.

Setup still to do, by the owner:
- Create a reCAPTCHA **v3** key at google.com/recaptcha/admin with `callerwhale.com`, `auth.callerwhale.com` if used, and `tauri.localhost`. Put the site key and secret into the auth container only (secret never in GitHub, build variables, source or chat), set AUTH_BOT_PROTECTION=true, redeploy.
- A new key and code alone do not prove live verification: try a real sign-in and read the score Google returns.
