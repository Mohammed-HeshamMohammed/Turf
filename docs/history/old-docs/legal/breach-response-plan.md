# Breach response plan

A working plan for a security incident that may involve personal information (Caller Whale's own accounts, customers' lists, or the learning store). It is written so a person alone, at night, can follow it. A lawyer should adapt it to the company and the states involved.

## 0. Who

- **Incident lead:** the owner on call [NAME, PHONE]. **Backup:** [NAME, PHONE]. **Lawyer:** [FIRM, PHONE] (call as soon as a breach is likely, so advice is privileged).
- Keep a **timeline** from the first minute: what was seen, when, by whom, what was done. Write it in one document; do not delete anything.

## 1. Detect and decide (first hour)

Signs: a customer or a person reports misuse; unexpected rows or users; a credential or key seen in public; Coolify shows containers or env changed; a provider (Google, Cloudflare, Paddle, GitHub) sends a security alert; unusual traffic in the gateway or learning logs.

Ask: was personal information **accessed, copied, changed or lost by someone who should not have**? If yes or maybe, treat it as a breach until shown otherwise.

## 2. Contain (do these first, in this order)

1. **Cut the access:** rotate the exposed secret (token, key, password) in Coolify and redeploy the service; revoke sessions (auth service) if sign-in is involved; block the address in Cloudflare.
2. **Stop the harm:** if the learning store is involved, set `LEARNING_ENABLED=false` and redeploy it; if a service is compromised, stop its container in Coolify.
3. **Preserve evidence:** do not wipe. Export the Coolify logs of the affected services and the database audit table (`learning.audit`), take a snapshot of the affected database.

## 3. Assess (first 24 hours)

Write down: what data, whose (which workspaces), how many people, what states they live in, how it happened, whether it was encrypted, whether it is still happening. Use `GET /v1/stats` on the learning store for counts. Note that the learning store holds hashes and shapes only (no names, phones, emails or street addresses); say so, and whether the hash key was exposed (if it was, the hashes can be tested against known numbers).

## 4. Tell the right people (clocks start when you learn of it)

| Who | When | Notes |
|---|---|---|
| Customers whose workspaces are affected | **without undue delay, within 72 hours** of confirming (the DPA promises this) | what happened, what is affected, what we are doing, what they should do |
| People affected | as each state's breach law requires (many say "without unreasonable delay", some have day limits such as 30 or 45 days) | the lawyer decides who must be told and what the letter says |
| State attorneys general and regulators | as each state's law requires, often when 500 or 1,000 or more residents are affected | the lawyer files |
| Payment provider (Paddle), other providers | if their data or accounts are involved | |
| Law enforcement | if a crime | the lawyer advises |
| Insurers | at once, if the company has cyber insurance | many policies need early notice |

Do not guess the law of a state; the lawyer keeps a list of the 50 states' notification rules.

### Telling owners from Caller Whale (built 2026-11-18)

Staff send the owners' notice from the auth service: `POST /v1/admin/breach-notices` with the affected agencies (`org_ids`), when
Caller Whale learned of it (`discovered_at`), what happened and what they should do. Each owner is emailed at once; the record shows
whom, when, and whether it went within 72 hours of `discovered_at` (`GET /v1/admin/breach-notices`). It does not tell leads or
authorities: that follows the lawyer's list above. While the incident affects service, open a status incident too, so the banner and the
status page say so.

## 5. Fix and learn

Close the hole; check the other services for the same weakness; restore from a clean source; ask providers for logs; run `go test`/the checks; write a short report (what, why, what changed). Review this plan after every incident and at least once a year. Practise once a year: pretend a key is leaked and run steps 1 to 3.

## 6. Phone list and secrets (fill in, keep offline)

Lead, backup, lawyer, insurer, Coolify admin, Cloudflare admin, Google Cloud admin, Paddle admin, GitHub admin, registrar. Where the secret backups are (see key-custody.md).
