import { routes } from "../src/routes.js";
import { resolveSiteOrigin } from "../src/site.js";
const xml = (value) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
export function discoveryArtifacts({ origin, indexable = true }) {
  origin = resolveSiteOrigin(origin);
  const entries = indexable
    ? routes.filter((route) => route.indexable && route.sitemap)
    : [];
  return {
    "sitemap.xml":
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      entries
        .map((route) => `  <url><loc>${xml(origin + route.path)}</loc></url>`)
        .join("\n") +
      "\n</urlset>\n",
    // Crawlers may fetch account-entry pages to see their noindex. Robots is not access control.
    "robots.txt": `User-agent: *\n${indexable ? "Allow: /" : "Disallow: /"}\n\nSitemap: ${origin}/sitemap.xml\n`,
    "manifest.json":
      JSON.stringify(
        {
          name: "Caller Whale",
          short_name: "Caller Whale",
          description: "A desktop workspace for property outreach.",
          start_url: "/",
          scope: "/",
          display: "browser",
          lang: "en",
          background_color: "#f4efe7",
          theme_color: "#f4efe7",
          icons: [
            {
              src: "/favicon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
          ],
        },
        null,
        2,
      ) + "\n",
  };
}
