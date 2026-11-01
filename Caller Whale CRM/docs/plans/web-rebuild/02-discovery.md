# Sitemap XML, robots.txt and search visibility

Status: Proposed. Parent: [Web rebuild plan](README.md).

## One route registry

Declare path, page identifier, title, description, canonical path, indexability, sitemap eligibility, navigation group, rendering mode and replacement URL. Generate public route artifacts from it. Private capability names and staff actions are not entries in public search.

A public client bundle cannot make a feature secret. Search exclusion reduces discovery; the backend must refuse unauthorized access.

## Public host and URL policy

Canonical host is https://callerwhale.com. Redirect www to the apex while preserving a safe path/query. Choose no trailing slash for named pages and / for home; redirect aliases once with 301/308. Do not redirect unknown URLs to home or return 200 for a not-found page.

Canonical links and Open Graph URLs must update on client navigation as well as initial HTML. Social metadata uses genuine product assets. Callback/recovery URLs must never be canonical URLs.

## sitemap.xml

Generate UTF-8 XML at /sitemap.xml with the sitemap namespace and an XML content type. Include only absolute canonical HTTPS public URLs returning 200, indexable and ready for publication. Include /, /features, /pricing, /compare, /security and /contact. Include /privacy and /terms once approved, substantive and current.

Exclude account/auth routes, dashboards, admin capabilities, monitoring, APIs, query-string variants, preview hosts, redirected URLs and 404s. XML-escape values. Emit lastmod only from a real substantial content revision; omit it when unavailable. Do not make every deployment pretend every page changed.

A sitemap index is unnecessary for this small site; introduce it only when size/content types justify it. Submit the production sitemap in Search Console after release and inspect representative URLs.

## robots.txt

Production baseline:

    User-agent: *
    Allow: /

    Sitemap: https://callerwhale.com/sitemap.xml

Do not put noindex in robots.txt; Google does not support that rule. Do not list an /admin path there as a supposed privacy mechanism. Routes requiring noindex must remain crawlable where a crawler needs to see that directive. Authentication protects data regardless of crawler behavior.

Staging/preview: access restriction plus noindex headers, and a host-specific robots file that disallows crawling. Never ship staging's Disallow: / to production. Non-website service hosts have no sitemap and should return appropriate noindex headers on public documents/errors; this is not their authorization control.

## Indexing and search rules

| Surface | Required behavior |
| --- | --- |
| Marketing pages | Initial HTML with title, description, canonical and useful content; index/follow |
| Auth/account pages | Initial HTML and relevant document response header: noindex; never in sitemap |
| Dashboard documents | Noindex, private data no-store; neutral unauthenticated shell contains no user data |
| Admin/Grafana | No public discovery entries; /admin not a route; private service enforcement |
| Unknown paths | HTTP 404 and noindex |
| Internal site search | Search only approved public content on public pages; authorized results in dashboard scoped by server permissions |

Browser autocomplete/history cannot be controlled or erased by robots.txt. The site can control its own links/search results and crawler directives, not promise that a browser never displays a previously visited address.

## Structured data and assets

Use Organization/WebSite and SoftwareApplication structured data only when supported by visible true content. Do not publish draft prices as sale offers or invented ratings. Externalize JSON-LD or hash/nonce it consistently with CSP. Provide favicon, app icons, social cards and a web manifest only if its install behavior is intentional; a manifest does not imply offline private data support.

## Acceptance

Parse generated XML, compare URLs to the registry, request each sitemap URL, and verify status/canonical/noindex consistency. Validate robots and headers on the real host, www, staging and service hosts. Refresh and directly open every route. Confirm removed routes return the intended redirect or 404. Inspect raw HTML as well as hydrated DOM. Search Console submission is a release action; a valid sitemap does not guarantee indexing.

## Primary references

- [Google: build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Google: block indexing with noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)
- [Google: introduction to robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
