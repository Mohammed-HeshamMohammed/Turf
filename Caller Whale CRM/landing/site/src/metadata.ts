import { faqs } from "./pricing/content.ts";
import { notFoundRoute, routes } from "./routes.ts";
import { resolveSiteOrigin, site } from "./site.ts";

const routeByKey = (key: string) => routes.find(route => route.key === key) || notFoundRoute;

/** What a page tells search engines and link previews. `indexable: false` (a preview or staging build) blocks every page. */
export interface Metadata {
  title: string;
  description: string;
  canonical: string;
  robots: string;
  openGraph: Record<string, string>;
  jsonLd: Record<string, unknown> | null;
}

export function metadataFor(key: string, { origin = site.origin, indexable = true }: { origin?: string; indexable?: boolean } = {}): Metadata {
  const route = routeByKey(key);
  const base = resolveSiteOrigin(origin);
  const url = base + (route.key === "notfound" ? "/" : route.path);
  const index = indexable && route.indexable;
  const meta: Metadata = {
    title: route.title,
    description: route.description,
    canonical: url,
    robots: index ? "index, follow" : "noindex, nofollow",
    openGraph: { type: "website", site_name: site.name, title: route.title, description: route.description, url },
    jsonLd: null,
  };
  if (route.indexable) {
    const graph: Record<string, unknown>[] = [
      { "@type": "Organization", "@id": base + "/#organization", name: site.name, url: base + "/", logo: base + "/favicon.svg" },
      { "@type": "WebSite", "@id": base + "/#website", name: site.name, url: base + "/", inLanguage: "en", publisher: { "@id": base + "/#organization" } },
      { "@type": "WebPage", "@id": url + "#webpage", url, name: route.title, description: route.description, inLanguage: "en", isPartOf: { "@id": base + "/#website" } },
    ];
    if (route.key === "pricing") {
      graph.push({
        "@type": "FAQPage",
        mainEntity: faqs.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
      });
    }
    meta.jsonLd = { "@context": "https://schema.org", "@graph": graph };
  }
  return meta;
}

const escape = (text: unknown) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The <head> markup for a page, written into the HTML when the pages are built. */
export function renderMetadata(meta: Metadata) {
  const og = Object.entries(meta.openGraph).map(([name, value]) => `<meta property="og:${name}" content="${escape(value)}" />`);
  return [
    `<title>${escape(meta.title)}</title>`,
    `<meta name="description" content="${escape(meta.description)}" />`,
    `<meta name="robots" content="${meta.robots}" />`,
    `<link rel="canonical" href="${escape(meta.canonical)}" />`,
    ...og,
    '<meta name="twitter:card" content="summary" />',
    // Data inside a JSON script cannot close the tag: "<" is escaped.
    ...(meta.jsonLd ? [`<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c")}</script>`] : []),
  ].join("\n    ");
}

/** In the browser, moving between pages changes the title, description and canonical address as the prerendered page would have had them. */
export function applyMetadata(meta: Metadata) {
  document.title = meta.title;
  const set = (selector: string, make: () => Element, attribute: string, value: string) => {
    let element = document.head.querySelector(selector);
    if (!element) {
      element = make();
      document.head.append(element);
    }
    element.setAttribute(attribute, value);
  };
  const tag = (name: string, value: string) => {
    const element = document.createElement("meta");
    element.setAttribute("name", name);
    element.setAttribute("content", value);
    return element;
  };
  set('meta[name="description"]', () => tag("description", ""), "content", meta.description);
  set('meta[name="robots"]', () => tag("robots", ""), "content", meta.robots);
  set('link[rel="canonical"]', () => Object.assign(document.createElement("link"), { rel: "canonical" }), "href", meta.canonical);
}
