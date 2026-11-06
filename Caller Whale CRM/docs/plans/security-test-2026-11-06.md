# Security test, 6 November 2026

**What was tested:** every public host (`callerwhale.com`, `app.`, `auth.`, `gate.`, `mcp.`, `coolify.`) and the server's address, from the outside, as an attacker would see them. Low volume and nothing destructive: no load, no password guessing against real accounts, no changes to anyone's data. The script is kept in the session scratchpad; this page is the result.

## Summary

The application layer held up. Every attempt to reach a private route, trick the gateway's path checks, forge a token, misuse the assistant sign-in or read another site's data was refused. The weak points are around the application: the server can be reached without going through Cloudflare, SSH is open to the world, and Coolify's login is public.

| # | Finding | Severity | State |
| --- | --- | --- | --- |
| 1 | The server answers on ports 80 and 443 to anyone, so Cloudflare's protection can be skipped by talking to the address directly | High | **Needs the server**: see below |
| 2 | Coolify's login page is on the open internet | High | **Needs Cloudflare Access** (your account) |
| 3 | SSH (port 22) is open to the world | Medium | **Needs the server** |
| 4 | API answers through the gateway carried no HSTS, `nosniff`, framing or no-store headers | Medium | **Fixed** in the gateway |
| 5 | An assistant could register under any name, including markup, and could call itself "Claude" | Medium | **Fixed**: names are plain text, and the consent page warns when the app does not return to a known assistant |
| 6 | The CRM web app answered `/.env`, `/.git/config` and other scanner paths with its page (status 200), which makes scanners try harder | Low | **Fixed**: hidden files are a plain 404 |
| 7 | An unused DNS name, `api.callerwhale.com`, pointed at the server | Low | **Fixed**: deleted |
| 8 | All containers share one Docker network | Medium | Planned (see the exposure review) |

## What was tried and refused

- **Private routes:** `/v1/connectors/introspect`, `/v1/connectors/standing`, `/internal/*`, `/healthz`, `/version`, `/metrics`, `/debug/pprof/`, `/openapi.yaml`, `/swagger`, `/.env`, `/.git/config` on the auth, gateway and MCP hosts: all 404. The monitoring path needs a staff token (401).
- **Path tricks** past the gateway's allow-list: `..`, `%2e%2e`, double slashes, a trailing `%00`, upper case, a trailing slash, `;` segments, query strings. All 404 or 400; nothing reached a private route.
- **Header tricks:** `Host: auth:8101` and `X-Forwarded-Host` through the gateway were refused or ignored. `TRACE` is not allowed (405).
- **CORS:** a page on another site gets no permission from auth. Only Caller Whale's own pages do.
- **Assistant sign-in (OAuth):** `javascript:` and plain-`http` return addresses, more than five return addresses, an unknown app, a return address the app did not register, and the weak `plain` PKCE method were all refused before any redirect, so it cannot be used as an open redirect. Made-up codes and refresh tokens are refused. Consent and the connection list need a signed-in person.
- **MCP:** no token, a forged token, an unsigned (`alg: none`) token-looking string and a 2 MiB body were all refused with 401 before any work was done.
- **Accounts:** sign-in and sign-up are refused without the human check, which is switched on. Forgot-password says the same thing for any address, so it does not reveal who has an account. A token not signed by auth is refused.
- **The website** and the CRM web app send a strict content security policy, HSTS, `nosniff`, `X-Frame-Options: DENY`, a referrer policy and a permissions policy. No source maps or server banners are exposed (Cloudflare replaces the server name).

## What needs you, and how

### 1. Make the server answer only Cloudflare (High)

Anyone who knows the address `93.127.202.234` can talk to Traefik directly with any host name, skipping Cloudflare's firewall, bot protection and DDoS shield. The application still checks everything, but the edge protection is lost. Pick one:

- **Cloudflare Tunnel (best):** run `cloudflared` on the server and close ports 80 and 443 completely. Nothing on the server listens to the internet any more. Coolify has a guide for this.
- **Firewall to Cloudflare's addresses:** allow 80 and 443 only from Cloudflare's published IP ranges. Docker skips `ufw`, so the rule must go in the `DOCKER-USER` chain (or use the hosting provider's firewall in front of the server).
- **Authenticated origin pulls:** Cloudflare presents a client certificate and Traefik refuses connections without it.

### 2. Put Coolify behind Cloudflare Access (High)

Coolify holds every secret. In Cloudflare Zero Trust, add a self-hosted application for `coolify.callerwhale.com` with a policy that allows only your email (one-time code or Google). The Coolify login stays as a second wall. Free for up to 50 people.

### 3. Close SSH to the world (Medium)

Allow port 22 only from your own address, or use the tunnel's SSH, and make sure password login is off (`PasswordAuthentication no`) and only keys work.

## Leftovers from the test

Two assistant registrations were made while testing ("Setup check" and one with a markup name, made before finding 5 was fixed). They have no grants and cannot do anything; they can be removed from the `connector_clients` table at any time.
