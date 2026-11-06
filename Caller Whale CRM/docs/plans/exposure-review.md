# What is public, what is private, and what goes through the gateway

**Status:** Reviewed 2026-11-06 against the live setup (Coolify domains, Cloudflare records, and requests from outside). The changes marked **Done** are in the code; the ones marked **Coolify** are settings you apply in Coolify or Cloudflare.

## The rule

Three zones, and a service belongs to exactly one:

1. **Public, static.** Nothing to attack but files: the landing site and the CRM web app. They sit behind Traefik and Cloudflare directly and hold no tokens.
2. **Public through the gateway.** Anything that runs code for a caller: it has no domain of its own. The gateway (`gate`, `auth`, and now `mcp`) is the only thing with a public address; it checks the host, the path, the size, the rate and (for the core API) the token, then passes the request on over the private network.
3. **Private.** Reached only by name on the Docker network, never by a public address: authorization, billing, notifications, the monitoring proxy, databases, Redis.

## Where every container stands

| Container | Zone | Public address | How it is reached | Verdict |
| --- | --- | --- | --- | --- |
| Landing site | public, static | `callerwhale.com` | Traefik, Cloudflare | Right. Static, no tokens |
| CRM web app | public, static | `app.callerwhale.com` | Traefik, Cloudflare | Right. Static; the CSP names only auth and the gateway |
| Gateway | the front door | `gate.`, `auth.` (and `mcp.`) | Traefik, Cloudflare | Right. The only dynamic public entry |
| Auth | via gateway | none of its own | `auth.callerwhale.com` goes to the gateway, which answers only auth's real public routes | Right. `introspect`, `standing`, `/healthz` and `/version` are not reachable from outside (checked: 404 through the public name) |
| Authorization | private | none | by name from auth | Right |
| Billing | private | none | by name from auth and the core API | Right |
| Notifications | private | none (only the contact form path, through the gateway) | by name | Right |
| Monitoring (Grafana and its proxy) | private | via the gateway's staff path | the proxy checks the staff session | Right |
| **MCP** | **should be via gateway** | **was `mcp.callerwhale.com` direct, plus a Coolify `sslip.io` address** | **Traefik directly** | **Wrong. Fixed below** |
| Databases | private | none | by name | Right (ports are closed: `8101`, `8106` and the other service ports time out from outside) |
| Coolify | the control plane | `coolify.callerwhale.com`, login page is public | Cloudflare | **Weak**: see finding 4 |

## Findings

1. **MCP bypassed the gateway.** It had its own public domain and the temporary `…sslip.io` address, which also skips Cloudflare (checked: the sslip address answered 200). So it had none of the gateway's host check, path allow-list, per-address limit, scan pause or body limit. **Done:** the gateway now has an `MCP_HOST` route that answers only `POST/GET/OPTIONS /mcp` and the two discovery paths (anything else is a plain Not found, and counts toward the scan pause), caps request bodies at 1 MiB, and rate-limits per address (default 6,000 a minute, higher than for people because assistants share a few addresses). **Coolify:** put `mcp.callerwhale.com` on the gateway, give the MCP app no domain, add the route (steps below).
2. **MCP answered without defensive headers.** **Done:** every MCP answer now carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a CSP that forbids framing.
3. **The shared secret could not be rotated without downtime.** **Done:** `AUTH_MCP_TOKEN` accepts two values (`new,old`), so the MCP service can be changed first and the old value dropped after, as billing already allows.
4. **Coolify's login is on the open internet.** Anyone can reach it, and it holds every secret. **Cloudflare:** put `coolify.callerwhale.com` behind Cloudflare Access (Zero Trust, free for a few people) so only your sign-in reaches the page, with the Coolify login as a second wall. Not done: it is an account setting of yours.
5. **`api.callerwhale.com` points at the server and answers 503.** No application serves that name. A record with nothing behind it invites subdomain-takeover mistakes later and shows up in scans. **Cloudflare:** delete it unless you know what it is for.
6. **Everything shares one Docker network.** Any container can reach any other. A compromise of the landing site's build, for instance, could reach billing. **Coolify:** give the private tier its own network (backend), and attach the gateway to both. Not done: it needs a redeploy of every app and a plan for moving them one at a time.
7. **Rate limits are in memory, one copy each.** Documented in the gateway plan. Fine for one server; a second copy needs Redis.
8. **Tokens issued to assistants are bound by our own check, not by an audience claim.** The MCP specification asks servers to accept only tokens meant for them. Ours are opaque, issued only by our auth, and introspected by the MCP service, so a token from another service cannot work there, and the MCP service never passes a token on to another service (the "token passthrough" mistake). Adding the `resource` parameter (RFC 8707) so a client can state the audience is a small next step.

## Checked and already right

- Every container runs as a non-root user and has a health check.
- No service port is reachable directly from outside (connections to `8101` and `8106` on the server's address time out).
- The gateway's `/healthz` and `/version`, and auth's private routes, answer only inside the network.
- No secret sits in a build argument; the CRM and website builds carry only public addresses.
- The staff dashboard needs the second step for owner actions, and a fresh one for anything that moves money or access.

## What to set (in this order, so nothing is public twice)

1. **MCP app → Domains:** delete `https://mcp.callerwhale.com` and the `http://…sslip.io` address. It now has no public address.
2. **Gateway app → Environment:** add `,mcp.callerwhale.com=http://mcp:8106` to the end of `ROUTES`; add `MCP_HOST=mcp.callerwhale.com` (and, optionally, `MCP_IP_PER_MINUTE`).
3. **Gateway app → Domains:** add `https://mcp.callerwhale.com`, port 8100.
4. **Redeploy the gateway and the MCP app.**
5. **Check from outside:** `https://mcp.callerwhale.com/.well-known/oauth-protected-resource` answers; `https://mcp.callerwhale.com/healthz` and `/` are 404; the old `sslip.io` address no longer answers.
6. **Cloudflare:** Access in front of Coolify; delete `api` if unused.

## Best practice this follows

- OWASP API Security Top 10 (API8 security misconfiguration, API9 improper inventory): one public entry, an allow-list per host, no forgotten hostnames.
- The Model Context Protocol authorization specification (2025-06-18): protected-resource discovery (RFC 9728), authorization-code flow with PKCE, short-lived tokens, no token passthrough.
- OAuth 2.1: PKCE required, refresh tokens rotate and work once, redirect addresses matched exactly.
- Defence in depth: the gateway checks, then the service checks again with its own rules.
- Least privilege: assistants get one read-only scope today and none of the destructive tools exist.
