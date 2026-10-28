# Mail server on Coolify

Our own SMTP server for softfix.dev, Turf and auto-linky.com: docker-mailserver, in one Coolify Docker Compose resource. Plan and progress: [docs/plans/mail-server.md](../../docs/plans/mail-server.md).

It **sends**. Incoming mail still goes through Cloudflare Email Routing (the MX records) to Gmail, so port 25 isn't published and nothing you receive today changes.

```
Turf, softfix-backend, auto-linky ──► smtp.softfix.dev:587 (login) ──► mail ──► the world, signed with DKIM
Thunderbird on your PC ────────────► smtp.softfix.dev:587 or :465 (login)
```

Apps use the public name `smtp.softfix.dev`, even from the same server, so the certificate matches.

## Before the first start (only you can do these)

1. **Outgoing port 25 must be open on the VPS.** In Coolify's Terminal on `localhost`: `timeout 6 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' && echo open || echo blocked`. If it's blocked, ask the VPS provider to open it.
2. **Reverse DNS:** set the PTR record of `187.7.72.171` to `smtp.softfix.dev` in the provider's panel. Without it Gmail and Outlook treat the mail as spam.
3. **Firewall:** open 587 and 465 to the internet (needed for Thunderbird; apps on the same server need them too, since they connect through the public name).
4. **A Cloudflare API token** that can edit DNS on `softfix.dev` only (Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS"). It's used only to prove to Let's Encrypt that you own `smtp.softfix.dev`.

## Setting it up in Coolify

1. **New resource → Docker Compose**, from this repository's `mail-production` branch (it holds only these files, at the same paths): base directory `/`, compose file `deploy/mail/compose.yml`. From `main` instead, use the base directory `/Full CRM Turf`.
2. **No domain.** Leave Domains empty on all three services.
3. **Environment variables**: see [.env.example](.env.example). The secrets are `CLOUDFLARE_API_TOKEN` and the mailbox passwords. Use long random ones.
4. **Deploy.** `certbot` asks for the certificate first (about a minute), then `mail-setup` makes the DKIM keys and mailboxes, then `mail` starts.
5. **Publish the DKIM keys.** Open the `mail-setup` logs in Coolify: it prints one `=== DKIM record` block per domain. Each is a TXT record named `mail._domainkey` on that domain. They replace the old `mail._domainkey` record of softfix.dev, whose private key was lost. Cloudflare may want the value on one line, without the quotes between the parts.

## DNS that must match

| Record | softfix.dev | auto-linky.com |
| --- | --- | --- |
| `smtp` A | `187.7.72.171`, **DNS only** | (not needed) |
| SPF (TXT at the root) | `v=spf1 ip4:187.7.72.171 include:_spf.mx.cloudflare.net -all` (already there) | `v=spf1 ip4:187.7.72.171 include:_spf.mx.cloudflare.net ~all`: add the IP to the record that's there |
| `mail._domainkey` TXT | the printed key | the printed key |
| `_dmarc` TXT | already there | `v=DMARC1; p=quarantine; rua=mailto:dmarc@auto-linky.com; adkim=r; aspf=r` |

## Using it

- **Thunderbird:** server `smtp.softfix.dev`, port 587 with STARTTLS (or 465 with SSL/TLS), user = the full address, password = its password. Mailboxes only send; mail to them is not delivered here (incoming mail goes to Cloudflare).
- **softfix-backend:** `SMTP_HOST=smtp.softfix.dev`, `SMTP_PORT=587`, `SMTP_SECURE=false` (STARTTLS), `SMTP_USER=no-reply@softfix.dev`, `SMTP_PASS`, `SMTP_HELO_NAME=smtp.softfix.dev`.
- **Another sender address or domain:** a login may only send as its own address (`SPOOF_PROTECTION`). Add a mailbox to `mail-setup` and, for a new domain, its name to the `setup config dkim` line, its DKIM, SPF and DMARC records.
- **Change a password:** in the `mail` container's terminal, `setup email update address newpassword`. The environment variable only matters the first time.

## Checks after it's up

- Send a test mail from Thunderbird to a Gmail address. In Gmail, "Show original" must say `SPF: PASS`, `DKIM: PASS` and `DMARC: PASS`.
- Log in with a wrong password a few times: Fail2ban bans the address.
- `mail` logs show no "relay access denied" for the apps.
