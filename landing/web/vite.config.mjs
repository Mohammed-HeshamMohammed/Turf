import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The contact page and contact API share a path. Keep browser GET navigation on
// Vite; forward form submissions to the landing API in development/preview.
const landingProxy = {
  "/waitlist": "http://localhost:8095",
  "/contact": {
    target: "http://localhost:8095",
    bypass(request) {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) return request.url;
    },
  },
};

export default defineConfig({
  plugins: [react(), {
    name: "prerendered-preview-pages",
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        // Serve the route's own prerendered document, rather than hydrating the
        // homepage on every clean URL in Vite's SPA preview fallback.
        if (request.method === "GET" && request.headers.accept?.includes("text/html")) {
          const url = new URL(request.url, "http://preview.local");
          const path = url.pathname.replace(/\/+$/, "");
          if (path && existsSync(resolve(server.config.root, server.config.build.outDir, `.${path}/index.html`))) {
            request.url = `${path}/index.html${url.search}`;
          }
        }
        next();
      });
    },
  }],
  server: { proxy: landingProxy },
  preview: { proxy: landingProxy },
});
