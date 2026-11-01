import { routeForKey } from "./routes.js";
import { site, resolveSiteOrigin } from "./site.js";

export function metadataFor(key, options = site) {
  const route = routeForKey(key);
  const origin = resolveSiteOrigin(options.origin);
  const indexable = options.indexable !== false && route.indexable;
  const url = origin + route.path;
  const image = origin + site.image;
  const schema = route.indexable
    ? {
        "@context": "https://schema.org",
        "@graph": [
          {
            "@type": "Organization",
            "@id": origin + "/#organization",
            name: site.name,
            url: origin + "/",
            logo: origin + "/favicon.svg",
          },
          {
            "@type": "WebSite",
            "@id": origin + "/#website",
            name: site.name,
            url: origin + "/",
            inLanguage: "en",
            publisher: { "@id": origin + "/#organization" },
          },
          {
            "@type": "WebPage",
            "@id": url + "#webpage",
            url,
            name: route.title,
            description: route.description,
            inLanguage: "en",
            isPartOf: { "@id": origin + "/#website" },
            ...(route.path !== "/"
              ? { breadcrumb: { "@id": url + "#breadcrumb" } }
              : {}),
          },
          ...(route.path !== "/"
            ? [
                {
                  "@type": "BreadcrumbList",
                  "@id": url + "#breadcrumb",
                  itemListElement: [
                    {
                      "@type": "ListItem",
                      position: 1,
                      name: "Home",
                      item: origin + "/",
                    },
                    {
                      "@type": "ListItem",
                      position: 2,
                      name: route.label,
                      item: url,
                    },
                  ],
                },
              ]
            : []),
        ],
      }
    : null;
  return {
    ...route,
    url,
    image,
    canonical: route.indexable ? url : null,
    robots: indexable
      ? "index,follow,max-image-preview:large"
      : "noindex,nofollow",
    schema,
  };
}

export function metadataElements(meta) {
  const tag = (name, attrs = {}, text) => ({
    name,
    attrs: { "data-page-meta": "", ...attrs },
    text,
  });
  return [
    tag("title", {}, meta.title),
    tag("meta", { name: "description", content: meta.description }),
    tag("meta", { name: "robots", content: meta.robots }),
    tag("meta", { property: "og:type", content: "website" }),
    tag("meta", { property: "og:site_name", content: site.name }),
    tag("meta", { property: "og:locale", content: "en_US" }),
    ...["title", "description", "image"].map((key) =>
      tag("meta", { property: `og:${key}`, content: meta[key] }),
    ),
    tag("meta", { property: "og:image:width", content: "1536" }),
    tag("meta", { property: "og:image:height", content: "1024" }),
    tag("meta", { property: "og:image:alt", content: site.imageAlt }),
    tag("meta", { name: "twitter:card", content: "summary_large_image" }),
    ...["title", "description", "image"].map((key) =>
      tag("meta", { name: `twitter:${key}`, content: meta[key] }),
    ),
    tag("meta", { name: "twitter:image:alt", content: site.imageAlt }),
    ...(meta.canonical
      ? [
          tag("link", { rel: "canonical", href: meta.canonical }),
          tag("meta", { property: "og:url", content: meta.url }),
        ]
      : []),
    ...(meta.schema
      ? [
          tag(
            "script",
            { type: "application/ld+json" },
            JSON.stringify(meta.schema).replace(/</g, "\\u003c"),
          ),
        ]
      : []),
  ];
}
const escape = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
export function renderMetadata(meta) {
  return metadataElements(meta)
    .map(({ name, attrs, text }) => {
      const attributes = Object.entries(attrs)
        .map(([key, value]) => ` ${key}="${escape(value)}"`)
        .join("");
      if (name === "meta" || name === "link") return `<${name}${attributes}>`;
      return `<${name}${attributes}>${name === "script" ? text : escape(text)}</${name}>`;
    })
    .join("\n    ");
}
export function applyMetadata(key) {
  document.head
    .querySelectorAll("[data-page-meta]")
    .forEach((element) => element.remove());
  for (const spec of metadataElements(metadataFor(key))) {
    const element = document.createElement(spec.name);
    for (const [key, value] of Object.entries(spec.attrs))
      element.setAttribute(key, value);
    if (spec.text !== undefined) element.textContent = spec.text;
    document.head.append(element);
  }
}
