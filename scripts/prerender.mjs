// Writes every page of the site as finished HTML, so search engines, link previews and slow connections get the page itself
// and not an empty shell. Runs after `vite build` (the browser files) and `vite build --ssr` (the same pages as code for the
// server): each route is rendered into its own folder, with its own title, description, canonical address and structured data.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ssr = join(root, "dist-ssr");
const { render, routes, notFoundRoute, metadataFor, renderMetadata, discoveryArtifacts, resolveSiteOrigin } = await import(
  pathToFileURL(join(ssr, "entry-server.js")).href
);

// SITE_URL names the public address (default https://callerwhale.com). SITE_INDEXABLE=false makes a preview that asks search
// engines to stay away.
const options = { origin: resolveSiteOrigin(process.env.SITE_URL), indexable: process.env.SITE_INDEXABLE !== "false" };

const template = readFileSync(join(dist, "index.html"), "utf8");
const slot = /<!-- page-metadata:start -->[\s\S]*?<!-- page-metadata:end -->/;
if (!slot.test(template)) throw new Error("The HTML template is missing its page metadata slot.");
if (!template.includes('<div id="root"></div>')) throw new Error("The HTML template is missing its root element.");

for (const route of [...routes, notFoundRoute]) {
  const html = template
    .replace(slot, () => renderMetadata(metadataFor(route.key, options)))
    .replace('<div id="root"></div>', () => `<div id="root">${render(route.path)}</div>`);
  const file = route.key === "notfound" ? join(dist, "404.html") : join(dist, route.path === "/" ? "" : route.path.slice(1), "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}
for (const [file, content] of Object.entries(discoveryArtifacts(options))) writeFileSync(join(dist, file), content);
rmSync(ssr, { recursive: true, force: true });
console.log(`Prerendered ${routes.length + 1} pages; sitemap and robots written for ${options.origin}.`);
