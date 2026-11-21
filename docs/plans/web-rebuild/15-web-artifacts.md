# Web artifacts, route metadata and publication contract

Status: Proposed artifact specification; examples are documentation, not deployed files.
Parent: [Master plan](README.md). Policy: [Discovery](02-discovery.md).

## Route registry schema

Each route record needs id, path, layout, audience, rendering mode, title, description, canonical path, indexability, sitemap inclusion, navigation group, aliases/replacement and content revision source. Validation rejects duplicate paths, missing page plans, private entries in public navigation/sitemap and canonicals pointing at a redirect/404.

Use explicit eligibility, not a rule that every new route is indexable by default. Staff-mode task registries are separate from public search/navigation. Query values and user identifiers never become sitemap entries.

Build routing, prerender list, metadata and discovery artifacts from the same approved source. Runtime client navigation updates title/description/canonical/social metadata consistently. The server must still return the right status and noindex headers; a client mutation alone is not enough.

## Artifact inventory

| Artifact | Required rule | Check |
| --- | --- | --- |
| /sitemap.xml | Canonical public indexable 200 URLs only, escaped XML, correct namespace/content type | Parse and compare to registry; request all entries |
| /robots.txt | Correct host's policy and production sitemap reference | No staging disallow or accidental admin directory advertisement |
| Page metadata | Unique title/description, canonical and true Open Graph content | Initial HTML and route changes agree |
| Private document headers | Noindex/no-store as appropriate, no private prerendered data | Direct load and errors, not only successful client navigation |
| /404.html and unknown routes | Real 404 with noindex and safe valid exits | Unknown nested path not a 200 homepage |
| Favicon/app icons | Actual approved brand, appropriate sizes/types | No stale Turf or generated replacement mark |
| Social preview image | Truthful approved composition, no private data | Actual public fetch/crop/readability |
| Hashed assets | Long immutable cache; correct MIME, compression and dimensions | New release loads current hashes |
| HTML documents | Revalidation for public documents; private/token document cache policy | No old build stranded behind cache |
| Source maps | Deliberate publication policy; no credentials/private content | Inspect final artifacts and reporting access |

## Illustrative production sitemap

Use only routes actually ready for publication; legal pages may be added once substantive/approved. Do not emit a fabricated lastmod.

    <?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://callerwhale.com/</loc></url>
      <url><loc>https://callerwhale.com/features</loc></url>
      <url><loc>https://callerwhale.com/pricing</loc></url>
      <url><loc>https://callerwhale.com/compare</loc></url>
      <url><loc>https://callerwhale.com/security</loc></url>
      <url><loc>https://callerwhale.com/contact</loc></url>
    </urlset>

No auth, dashboard, staff, monitoring, API, token query, old alias, preview host or unavailable feature page. Sitemap index splitting is unnecessary at current page count. Search engine submission is a later release action and does not guarantee indexing.

## Illustrative robots policies

Production:

    User-agent: *
    Allow: /

    Sitemap: https://callerwhale.com/sitemap.xml

Staging adds access restriction and noindex headers; its robots may disallow /. Do not transfer that file to production. Production noindex account pages must be crawlable when the crawler needs to see the directive; authentication is the data boundary. Never use a robots noindex directive or list /admin as a security tactic.

## Optional files and deliberate omissions

An HTTPS security.txt can be considered once a real monitored reporting contact, ownership and maintenance/expiry process are approved. It is not automatically generated from an example email address.

A web manifest requires intentional icons/name/start-url/install behavior; do not imply offline account-data caching or desktop updater support. A service worker is not part of this visual rebuild by default. If introduced later, explicitly prevent private/token responses entering shared caches and define update/rollback behavior.

humans.txt is optional attribution, unrelated to human verification. llms.txt, feeds, ads.txt, blog schemas and sitemap indexes are not required just to make a site feel complete; add only with a real use/owner. No unowned public contact or unsupported standard is treated as access control.

## Header and integration review

Define CSP per actual required script/frame/connect/form destinations; keep private framing restrictions and strict script policy. Use explicit reviewed Referrer-Policy, X-Content-Type-Options and transport policy for intended HTTPS hosts. Hash/nonces/externalized structured data must work with the chosen rendering/deployment model.

CORS is configured at receiving services and gateway-generated error boundaries, with exact allowed origins and tested OPTIONS plus actual requests. Cookies, if chosen under D04, add CSRF requirements and a different credential contract. Never add wildcard credentialed CORS to hide a sign-in error.

## Acceptance

V01–V05/V18–V19/V28–V30 cover artifact publication. Save raw response/status/header and parsed metadata evidence with build/host; screenshots alone cannot prove robots, cache or CORS behavior. Validate production and staging independently after deployment.
