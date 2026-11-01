import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { routeForPath } from "./src/routes.js";
import { resolveSiteOrigin } from "./src/site.js";
import { discoveryArtifacts } from "./scripts/discovery.mjs";

const options = {
  origin: resolveSiteOrigin(process.env.SITE_URL),
  indexable: process.env.SITE_INDEXABLE !== "false",
};
const landingProxy = {
  "/waitlist": "http://localhost:8095",
  "/contact": {
    target: "http://localhost:8095",
    bypass(request) {
      if (
        request.method === "GET" &&
        request.headers.accept?.includes("text/html")
      )
        return request.url;
    },
  },
};
const types = {
  "sitemap.xml": "application/xml; charset=utf-8",
  "robots.txt": "text/plain; charset=utf-8",
  "manifest.json": "application/manifest+json; charset=utf-8",
};
export default defineConfig({
  define: {
    __SITE_ORIGIN__: JSON.stringify(options.origin),
    __SITE_INDEXABLE__: JSON.stringify(options.indexable),
  },
  plugins: [
    react(),
    {
      name: "page-discovery-and-preview",
      configureServer(server) {
        const artifacts = discoveryArtifacts(options);
        server.middlewares.use((request, response, next) => {
          const name = new URL(request.url, "http://dev.local").pathname.slice(
            1,
          );
          if (
            !Object.hasOwn(artifacts, name) ||
            !["GET", "HEAD"].includes(request.method)
          )
            return next();
          response.writeHead(200, {
            "Content-Type": types[name],
            "Cache-Control": "no-cache",
          });
          response.end(request.method === "HEAD" ? "" : artifacts[name]);
        });
      },
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          if (
            !["GET", "HEAD"].includes(request.method) ||
            !request.headers.accept?.includes("text/html")
          )
            return next();
          const url = new URL(request.url, "http://preview.local");
          const route = routeForPath(url.pathname);
          if (route.key !== "notfound") {
            request.url =
              route.path === "/"
                ? "/index.html"
                : `${route.path}/index.html${url.search}`;
            return next();
          }
          const dist = resolve(server.config.root, server.config.build.outDir);
          const file = resolve(dist, `.${url.pathname}`);
          if (
            file.startsWith(dist + sep) &&
            existsSync(file) &&
            statSync(file).isFile()
          )
            return next();
          const fallback = resolve(dist, "404.html");
          if (!existsSync(fallback)) return next();
          response.writeHead(404, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Robots-Tag": "noindex",
          });
          response.end(request.method === "HEAD" ? "" : readFileSync(fallback));
        });
      },
    },
  ],
  server: { proxy: landingProxy },
  preview: { proxy: landingProxy },
});
