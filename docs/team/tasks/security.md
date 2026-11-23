# Security

Review of `gateway`, `auth`, `authz`, `grafana-proxy`; Cloudflare and firewall; secrets. Routine: [security upkeep](../../operations/security-upkeep.md),
[rotating service tokens](../../operations/rotating-service-tokens.md).

| ID | Task | Needs | Source | Taken by | Status |
| --- | --- | --- | --- | --- | --- |
| SEC-01 | Read the security setup: the gateway's shield, sign-in and second step, authz grants, Cloudflare rules | — | Team plan | | open |
| SEC-02 | Dismiss the withdrawn advisory on GitHub, with the reason | — | Step 43 | | open |
| SEC-03 | Review the dialer before it leaves simulate mode: webhook signatures, budgets, who can call | SEC-01 | Steps 21, 22 | | open |
| SEC-04 | The monthly update review (Dependabot), written down each month | — | Step 43 | | open |
| SEC-05 | The yearly secret change, tried once now on one service to prove the procedure | — | [Rotating service tokens](../../operations/rotating-service-tokens.md) | | open |
| SEC-06 | Choose and book the outside security test before opening, with what it must cover | SEC-01 | Step 43 | | open |
| SEC-07 | The breach procedure walked through once as a drill | LAW-15 | Step 34 | | open |
| SEC-08 | The glib fix with the desktop upgrade | Desktop un-parked | Step 43 | | open |
