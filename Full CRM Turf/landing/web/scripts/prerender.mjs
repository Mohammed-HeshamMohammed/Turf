// Writes every page of the site as plain HTML, so search engines, link previews and people without scripts see
// the content, and the page hydrates once scripts load. Run by `npm run build` after the client and server builds.
//
// SITE_URL (for example https://turf.example) turns on canonical links, og:url, sitemap.xml and the Sitemap line in robots.txt.
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ssr = join(root, "dist-ssr");
const site = (process.env.SITE_URL || "").replace(/\/$/, "");

const { render, pageMeta } = await import(pathToFileURL(join(ssr, "entry-server.js")).href);
const template = readFileSync(join(dist, "index.html"), "utf8");

const PAGES = [
  ["/", "home"], ["/features", "features"], ["/pricing", "pricing"], ["/compare", "compare"],
  ["/security", "security"], ["/contact", "contact"], ["/privacy", "privacy"], ["/terms", "terms"],
  ["/signin", "signin"], ["/signup", "signup"], ["/dashboard", "dashboard"], ["/admin", "admin"], ["/admin/grafana", "grafana"],
];
// A signed-in person's pages: never indexed, never in the sitemap.
const PRIVATE = ["signin", "signup", "dashboard", "admin", "grafana"];
const esc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function page(path, key) {
  const [title, description] = pageMeta[key];
  let html = template
    .replace(/<title>.*?<\/title>/s, `<title>${esc(title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[^"]*(")/s, `$1${esc(description)}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/s, `$1${esc(title)}$2`)
    .replace('<div id="root"></div>', `<div id="root">${render(path)}</div>`);
  if (key === "notfound" || PRIVATE.includes(key)) html = html.replace("</head>", '    <meta name="robots" content="noindex" />\n  </head>');
  if (site && key !== "notfound" && !PRIVATE.includes(key)) {
    const url = site + (path === "/" ? "/" : path);
    html = html.replace("</head>", `    <link rel="canonical" href="${url}" />\n    <meta property="og:url" content="${url}" />\n  </head>`);
  }
  return html;
}

function write(path, html) {
  const file = path === "/" ? join(dist, "index.html") : join(dist, path.slice(1), "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}

for (const [path, key] of PAGES) write(path, page(path, key));
writeFileSync(join(dist, "404.html"), page("/404", "notfound"));

if (site) {
  const urls = PAGES.filter(([, key]) => key !== "privacy" && key !== "terms" && !PRIVATE.includes(key))
    .map(([path]) => `  <url><loc>${site}${path}</loc></url>`)
    .join("\n");
  writeFileSync(join(dist, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  writeFileSync(join(dist, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap.xml\n`);
} else {
  console.warn("SITE_URL is not set: no canonical links, sitemap.xml or Sitemap line were written.");
}

rmSync(ssr, { recursive: true, force: true });
console.log(`Prerendered ${PAGES.length + 1} pages.`);
