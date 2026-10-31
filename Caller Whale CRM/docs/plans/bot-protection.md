# Optional human verification

Auth alone verifies Cloudflare Turnstile tokens. Off by default. Set AUTH_BOT_PROTECTION=true only after entering real AUTH_TURNSTILE_SITE_KEY and AUTH_TURNSTILE_SECRET_KEY and wiring the widget. Missing keys prevent startup. Never expose the secret key.

GET /v1/security publicly returns bot_protection {enabled,site_key} and password_policy {minimum:8,maximum:4096,uppercase:true,lowercase:true,number:true,special:true}. Disabled site_key is an empty string.

Frontend contract: include human_token:string in SignUp (POST /v1/accounts) and SignIn (POST /v1/sessions). Widget action must be signup or signin respectively. Reset the widget after each submission: tokens are single use. All password submissions, including legacy code submissions, are checked; sending an empty or arbitrary code cannot bypass verification. Challenge-based /v1/mfa responses retain their existing authentication checks and do not repeat the first-leg CAPTCHA.

The backend posts to the fixed HTTPS Cloudflare Siteverify endpoint with an eight-second timeout and no redirects. Tokens must be nonblank and at most 2048 bytes. Failure, timeout, wrong action, or hostname mismatch returns 403 with code human_required. No user-supplied IP is trusted or forwarded. Cloudflare handles token expiry and replay rejection; every submission is verified remotely.

AUTH_TURNSTILE_HOSTNAMES optionally supplies exact comma-separated hostnames. Otherwise auth derives them from AUTH_ALLOWED_ORIGINS and configured public, website, landing and app URLs. Configure the Turnstile widget domain allowlist to match. Windows desktop HTTP webviews may explicitly allow tauri.localhost using AUTH_TURNSTILE_HOSTNAMES (include the web hostnames too). Turnstile on tauri:// origins is unsupported; a future macOS flow needs a supported HTTPS browser handoff. Do not use dummy keys or enable live protection before frontend support is deployed.


The website and desktop share `services/auth/clients/human-check.jsx`, synchronized with the auth client. POST /v1/oauth/{provider}/start accepts {target,port,human_token,action} and returns {url}; GET provider starts are refused while protection is enabled, preventing a direct-address bypass. Managed mode allows Cloudflare to choose whether an interactive human check is needed. The parent CSP permits only the Cloudflare challenge origin for this external script/frame.

Current deployment setup: the Cloudflare widget is named **Caller Whale authentication**, in Managed mode with no pre-clearance, restricted to `callerwhale.com` (including its subdomains) and `tauri.localhost`. Enter its secret directly in the auth container's AUTH_TURNSTILE_SECRET_KEY setting; do not put it in GitHub, frontend build variables, source or chat. Keep AUTH_BOT_PROTECTION=false until that entry and updated clients are complete. A new widget and code alone do not prove successful live human verification.
