# Mail DNS records removed, 6 November 2026

All mail records for callerwhale.com were removed from Cloudflare DNS on request, "for now". This is the full list, so any of them can be added back. All were "DNS only", TTL Auto.

| Name | Type | Content | Priority |
| --- | --- | --- | --- |
| callerwhale.com | MX | route1.mx.cloudflare.net | 2 |
| callerwhale.com | MX | route2.mx.cloudflare.net | 72 |
| callerwhale.com | MX | route3.mx.cloudflare.net | 86 |
| inbox.callerwhale.com | MX | smtp.softfix.dev | 10 |
| callerwhale.com | TXT | `v=spf1 ip4:187.7.72.171 include:_spf.mx.cloudflare.net -all` | |
| inbox.callerwhale.com | TXT | `v=spf1 -all` | |
| _dmarc.callerwhale.com | TXT | `v=DMARC1; p=quarantine; rua=mailto:dmarc@softfix.dev; adkim=r; aspf=r` | |
| cf2024-1._domainkey.callerwhale.com | TXT | Cloudflare Email Routing key (re-created by turning Email Routing back on) | |
| mail._domainkey.callerwhale.com | TXT | `v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmtwdXJC6mmsDLeZWCjdRvP/TX0THTRrMUI2M+1xhgYobFVqg9vdWVwjwl+pxoRDNEnqKnHvw2YXV4/YxRn8Ggd0JNqVsKEzFx/V4nXGbuk0NI8a7skFx+uktp2jat7DtD/ESPRgRRHwg6FGxNmW+jwOy/uQqNfi3NFYVdFHATXzZQftJKlKzdfpQgrKzpp22CAX4emlolfi6oY2Z1fPw9k4ysw8r9MVj2lZh+vZOmr3z6c9Uib9zeqja5DPgUvpMKwhXXRTMVJI8j2ZwBP5DdBxZM3F4zLFZLO70DC1dMpHY6wQIzPvxghd8z9vHPF4qMh9EI2GZvy+MxssqcBoSqQIDAQAB` | |

**Effect:** the domain no longer receives mail, and mail sent from it has no SPF, DKIM or DMARC, so receivers may put it in spam or refuse it. Sign-up, reset and sign-in code emails sent from this domain are affected until the records are restored.
