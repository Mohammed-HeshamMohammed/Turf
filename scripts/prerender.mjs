import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { routes, notFoundRoute } from "../src/routes.js";
import { metadataFor, renderMetadata } from "../src/metadata.js";
import { resolveSiteOrigin } from "../src/site.js";
import { discoveryArtifacts } from "./discovery.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const ssr = join(root, "dist-ssr");
const options = {
  origin: resolveSiteOrigin(process.env.SITE_URL),
  indexable: process.env.SITE_INDEXABLE !== "false",
};
const { render } = await import(
  pathToFileURL(join(ssr, "entry-server.js")).href
);
const template = readFileSync(join(dist, "index.html"), "utf8");
const marker = /<!-- page-metadata:start -->[\s\S]*?<!-- page-metadata:end -->/;
if (!marker.test(template))
  throw new Error("The HTML template is missing its page metadata slot.");
for (const route of [...routes, notFoundRoute]) {
  const html = template
    .replace(marker, renderMetadata(metadataFor(route.key, options)))
    .replace(
      '<div id="root"></div>',
      () => `<div id="root">${render(route.path)}</div>`,
    );
  const file =
    route.key === "notfound"
      ? join(dist, "404.html")
      : join(dist, route.path === "/" ? "" : route.path.slice(1), "index.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
}
for (const [file, content] of Object.entries(discoveryArtifacts(options)))
  writeFileSync(join(dist, file), content);
rmSync(ssr, { recursive: true, force: true });
console.log(
  `Prerendered ${routes.length + 1} pages; sitemap, robots and manifest written for ${options.origin}.`,
);
