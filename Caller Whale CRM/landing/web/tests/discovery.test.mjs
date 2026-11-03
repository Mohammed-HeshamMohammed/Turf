import test from "node:test";
import assert from "node:assert/strict";
import { routes, PAGE_PATHS, routeForPath } from "../src/routes.js";
import {
  metadataFor,
  metadataElements,
  renderMetadata,
} from "../src/metadata.js";
import { discoveryArtifacts } from "../scripts/discovery.mjs";
import { resolveSiteOrigin } from "../src/site.js";

test("every route has unique paths/keys and complete page metadata", () => {
  assert.equal(new Set(routes.map((r) => r.path)).size, routes.length);
  assert.equal(new Set(routes.map((r) => r.key)).size, routes.length);
  for (const route of routes) {
    assert(route.title && route.description && route.label);
    assert.equal(PAGE_PATHS[route.path], route.key);
    assert.equal(
      routeForPath(route.path + (route.path === "/" ? "" : "/")).key,
      route.key,
    );
    const meta = metadataFor(route.key);
    const tags = metadataElements(meta);
    for (const attribute of [
      "og:title",
      "og:description",
      "twitter:title",
      "twitter:description",
    ]) {
      const tag = tags.find(
        (t) => t.attrs.property === attribute || t.attrs.name === attribute,
      );
      assert.equal(
        tag.attrs.content,
        attribute.endsWith(":title") ? route.title : route.description,
      );
    }
    if (!route.indexable) {
      assert.equal(meta.robots, "noindex,nofollow");
      assert.equal(meta.canonical, null);
      assert.equal(meta.schema, null);
    }
  }
  assert.equal(routeForPath("/not-a-page").key, "notfound");
});

test("sitemap contains exactly the approved public routes and absolute URLs", () => {
  const { ["sitemap.xml"]: sitemap, ["robots.txt"]: robots } =
    discoveryArtifacts({ origin: "https://callerwhale.com" });
  const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(
    urls,
    routes
      .filter((r) => r.sitemap && r.indexable)
      .map((r) => "https://callerwhale.com" + r.path),
  );
  for (const path of ["/signin", "/signup", "/dashboard", "/verify", "/desktop-sign-in"])
    assert(!sitemap.includes(path));
  assert(robots.includes("Sitemap: https://callerwhale.com/sitemap.xml"));
  assert(!sitemap.includes("lastmod")); // No invented build-date content changes.
});

test("non-indexable builds have no discoverable URLs and noindex on every page", () => {
  const artifacts = discoveryArtifacts({
    origin: "https://preview.example",
    indexable: false,
  });
  assert(artifacts["robots.txt"].includes("Disallow: /"));
  assert(!artifacts["sitemap.xml"].includes("<url>"));
  for (const route of routes)
    assert.equal(
      metadataFor(route.key, {
        origin: "https://preview.example",
        indexable: false,
      }).robots,
      "noindex,nofollow",
    );
});

test("canonical and social URLs are rooted in the configured origin", () => {
  const meta = metadataFor("pricing", {
    origin: "https://example.com/",
    indexable: true,
  });
  assert.equal(meta.canonical, "https://example.com/pricing");
  assert.equal(meta.image, "https://example.com/images/property-hero.webp");
  assert.equal(
    meta.schema["@graph"].find((item) => item["@type"] === "WebPage").url,
    meta.url,
  );
});

test("site origin validation rejects credentials, paths and injection; metadata is escaped", () => {
  for (const input of [
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com/?x=1",
    "invalid",
  ])
    assert.throws(() => resolveSiteOrigin(input));
  assert.equal(resolveSiteOrigin(), "https://callerwhale.com");
  const html = renderMetadata({
    ...metadataFor("home"),
    title: 'A <test> & "quote"',
    schema: null,
  });
  assert(html.includes("A &lt;test&gt; &amp; &quot;quote&quot;"));
});

test("structured data matches visible page identity without invented offers or reviews", () => {
  for (const route of routes.filter((route) => route.indexable)) {
    const graph = metadataFor(route.key).schema["@graph"];
    const page = graph.find((item) => item["@type"] === "WebPage");
    assert.equal(page.name, route.title);
    assert.equal(page.description, route.description);
    assert(!JSON.stringify(graph).includes("aggregateRating"));
    assert(!JSON.stringify(graph).includes("offers"));
  }
  const manifest = JSON.parse(
    discoveryArtifacts({ origin: "https://callerwhale.com" })["manifest.json"],
  );
  assert.equal(manifest.display, "browser");
  assert.equal(manifest.icons[0].src, "/favicon.svg");
});
