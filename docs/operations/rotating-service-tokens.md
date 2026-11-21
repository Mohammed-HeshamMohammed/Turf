# Service tokens: how services prove who is calling, and how to replace a token

Services talk to each other directly on the private network, not through the public gateway. The gateway guards what comes in
from the internet; between services, each call carries the caller's own token, and the service being called checks it and allows
only what that caller may do.

| Service called | Its list of callers | The caller's variable | Callers today |
|---|---|---|---|
| authz | `AUTHZ_TOKENS` | `AUTHZ_TOKEN` on auth and billing | auth, billing |
| billing | `BILLING_TOKENS` | `AUTH_BILLING_TOKEN` on auth | auth (dashboard summary) |
| notifications | `NOTIFY_TOKENS` | `AUTH_NOTIFY_TOKEN` on auth | auth (sign-in emails) |

Rules every service enforces:

- Each token is at least 32 characters (notifications: 24). A shorter one stops the service from starting, on purpose.
- Every token is different: two callers never share one.
- A caller may have **two** tokens at once, only while one is being replaced.

## Making a token

```bash
node tools/make-token.mjs auth
```

It prints `auth=<token>` for the service being called and the bare token for the caller. Paste them into Coolify's environment
variables only, never into a file in the repository.

## Replacing a token without downtime

Replace each token at least once a year, and straight away if it may have been seen by someone else (pasted in a chat, shown on a
screen, a laptop lost).

1. Make a new token with `node tools/make-token.mjs <caller>`.
2. On the service being called, **add** the new entry next to the old one, for example `BILLING_TOKENS=auth=<old>,auth=<new>`.
   Redeploy it. Both tokens now work.
3. On the caller, set its variable to the new token (for example `AUTH_BILLING_TOKEN=<new>`). Redeploy it.
4. On the service being called, **remove** the old entry. Redeploy it. The old token no longer works.

If step 2 is skipped, the caller is refused between steps 3 and 4.

## What else keeps this safe

- Billing, authz and notifications have no public domain: only containers on the server can reach them.
- Every service logs each request (method, path, status, time; never tokens or bodies). Grafana's **Service traffic** dashboard
  shows them all in one place, including refusals (401, 403) between services.
