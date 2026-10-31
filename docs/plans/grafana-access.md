# Current private monitoring route

Use `/staff/monitoring/` on `gate.callerwhale.com`; no dedicated Grafana domain.
The gateway forwards only that path to the private login proxy. Auth owns sign-in,
MFA and its tokens. The proxy requires MFA and recent authentication and checks the
core API staff verdict on every forwarded request. No session means no Grafana
content; a failed access check fails closed. Cookies are HttpOnly, Secure in
production, and scoped to `/staff/monitoring/`. All monitoring responses are no-store.

Deployment and cutover: [Grafana README](../../deploy/grafana/README.md).

The path is reachable on the internet but access-controlled; this is not a VPN-only
service. Browser visibility is not an authorization mechanism. Activity timeout
currently measures HTTP requests, not human presence; background requests can keep
an idle browser session alive until its maximum lifetime/token expiry. Sessions and
used-sign-in records are in one proxy process's memory and reset on restart.
