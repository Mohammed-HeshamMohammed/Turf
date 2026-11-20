import { routes } from "./routes.ts";
import { resolveSiteOrigin } from "./site.ts";

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The files search engines look for: the sitemap and robots.txt. A preview build (indexable: false) lists nothing and disallows everything. */
export function discoveryArtifacts({ origin, indexable = true }: { origin?: string; indexable?: boolean }): Record<string, string> {
  origin = resolveSiteOrigin(origin);
  const entries = indexable ? routes.filter(route => route.indexable && route.sitemap) : [];
  return {
    "sitemap.xml":
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      entries.map(route => `  <url><loc>${xml(origin + route.path)}</loc></url>`).join("\n") +
      "\n</urlset>\n",
    // Sign-in and account pages carry their own noindex; robots.txt is a request to crawlers, not access control.
    "robots.txt": `User-agent: *\n${indexable ? "Allow: /" : "Disallow: /"}\n\nSitemap: ${origin}/sitemap.xml\n`,
  };
}
