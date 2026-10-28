# Our own mail server (softfix.dev, Turf, auto-linky.com)

**Status:** Draft, nothing built yet (2026-10-28). It replaces the mail server that ran on Dokploy before the move to Coolify, and it replaces any plan to use Resend or another sending service.

**Goal:** one SMTP server on the VPS, run from Coolify, that sends for `softfix.dev`, Turf and `auto-linky.com`, and that people can also use from Thunderbird.

## What was there before (read from the DNS in Cloudflare)

| Record | Value | What it tells us |
| --- | --- | --- |
| `smtp.softfix.dev` A | `187.7.72.171`, DNS only | The server's name. It's the name the server gives when it says hello (`SMTP_HELO_NAME` in softfix-backend) |
| `softfix.dev` TXT (SPF) | `v=spf1 ip4:187.7.72.171 include:_spf.mx.cloudflare.net -all` | Only this server's IP (and Cloudflare's forwarding) may send. Good as it is |
| `smtp.softfix.dev` TXT (SPF) | `v=spf1 ip4:187.7.72.171 -all` | Same for the server's own name |
| `mail._domainkey` TXT | a 2048-bit RSA key | The old server's signing key, selector `mail`. `mail` is docker-mailserver's default selector, so that's probably what ran. Its private key stayed on Dokploy and is gone, so this record gets replaced |
| `_dmarc` TXT | `p=quarantine; rua=mailto:dmarc@softfix.dev; adkim=r; aspf=r` | Mail that fails SPF and DKIM is quarantined, with relaxed alignment. Keep it |
| MX | three `route*.mx.cloudflare.net` | **Incoming** mail doesn't go to our server: Cloudflare Email Routing catches it and forwards to a Gmail address |
| `cf2024-1._domainkey` TXT | Cloudflare's key | For Email Routing. Keep it |

## What's there now (checked 2026-10-28)

- No mail container in any Coolify project. Dokploy is gone: nothing answers on its port 3000.
- Nothing answers on 25, 465, 587, 993, 995, 110, 143 or 4190. Only 80 and 443 answer (Coolify's proxy).
- softfix-backend has `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `SMTP_HELO_NAME` and `MAIL_FROM_NAME`, but the first five are empty. Its contact-form mail goes nowhere.
- Turf can't send anything yet: auth writes "send this email" events to its outbox and nothing reads them, and the notifications service is a placeholder.
- `auto-linky.com` sends through Resend today (`resend._domainkey`, `send`, `rsend`) and receives through Cloudflare Email Routing to `autolinky2026@gmail.com`.

## Design

```
Turf, softfix-backend, auto-linky ──► mail server (Coolify, one resource, private network) ──► the world
Thunderbird on your PC ─────────────► mail server, port 587 or 465, with a mailbox login
```

1. **Software:** docker-mailserver, as one Coolify Docker Compose resource (`deploy/mail/compose.yml`). The settings live in the compose file and one volume. It signs each domain with its own DKIM key, and handles several domains.
2. **Sending first, receiving stays on Cloudflare.** MX stays on Cloudflare Email Routing, so incoming mail keeps reaching Gmail as it does now. The server only sends. Moving MX to the server is a later decision, and means removing the Cloudflare routing records for that domain.
3. **Apps send over the private network** (`mail:587` with a login), so no mail port needs to face the internet for them. Thunderbird needs 587 or 465 (and 993 if you want to read mail on the server) open to the internet.
4. **Certificates:** the server needs one for `smtp.softfix.dev`. Coolify's proxy owns ports 80 and 443, so the server can't ask Let's Encrypt for one itself the usual way. Plan: a small certbot container does a DNS challenge through the Cloudflare API, with an API token limited to editing DNS on `softfix.dev` and `auto-linky.com`. You create that token and paste it into Coolify.
5. **Domains and addresses:**

   | Domain | Sender addresses | DNS to change |
   | --- | --- | --- |
   | `softfix.dev` | `no-reply@`, `hello@`; Thunderbird uses your own mailbox | New `mail._domainkey` key. SPF and DMARC stay |
   | Turf | `no-reply@softfix.dev` or `no-reply@turf.softfix.dev`. DMARC's relaxed alignment lets the second be signed by `softfix.dev` | none beyond the above |
   | `auto-linky.com` | `no-reply@auto-linky.com` | SPF gets `ip4:187.7.72.171` added, a `mail._domainkey` key and a `_dmarc` record. The Resend records stay until nothing uses them |

## What only you can do

1. **Outgoing port 25 must be open on the VPS.** Many providers block it. If it's blocked, a support ticket usually lifts it. To check, in Coolify's Terminal, on `localhost`: `timeout 6 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' && echo open || echo blocked`.
2. **Reverse DNS:** set the PTR record for `187.7.72.171` to `smtp.softfix.dev` in the provider's panel. Gmail and Outlook treat mail from an IP without it as spam.
3. **Firewall:** open 587, 465 and 993 (the provider's panel or `ufw`) if Thunderbird should connect from outside.
4. **Secrets:** the Cloudflare API token for certificates, and the passwords of the mailboxes (the apps' sender login and your own). I can't enter these.

## Steps and progress

- [ ] **1. Decisions** (below) and the three provider checks above.
- [ ] **2. `deploy/mail/compose.yml`, README and `.env.example`**, with a `mail-production` branch like `grafana-production`.
- [ ] **3. Run it in Coolify**: the resource, the private network, volumes, the certificate container.
- [ ] **4. DNS:** the new DKIM keys, SPF and DMARC for `auto-linky.com`, then check with a test mail to a Gmail address and read the headers (SPF, DKIM and DMARC all pass).
- [ ] **5. Thunderbird** on your PC: server `smtp.softfix.dev`, port 587 (STARTTLS) or 465 (SSL), your mailbox login.
- [ ] **6. softfix-backend:** fill `SMTP_HOST` (`mail`), `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`.
- [ ] **7. Turf:** sending in the notifications service (Go's standard library speaks SMTP), reading auth's outbox, then confirmation, password-reset and invitation emails.
- [ ] **8. auto-linky:** its notify service sends through the server instead of Resend.

## Decisions

- **docker-mailserver, or another** (Mailu, Stalwart)? The plan assumes docker-mailserver, since the old setup looks like it.
- **Send only, or also receive on the server?** The plan assumes send only, with Cloudflare still forwarding incoming mail.
- **Which sender addresses for each project?** The plan assumes the table above.

## Log

- 2026-10-28: Plan written from the DNS records, the Coolify projects and port checks. The old Dokploy install and its mail server are gone, and the old DKIM private key with them.
