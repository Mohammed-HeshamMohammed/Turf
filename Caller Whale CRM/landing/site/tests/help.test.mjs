import assert from "node:assert/strict";
import test from "node:test";
import { helpArticles, searchHelp } from "../src/content/help.ts";

test("help search matches every word, in any article field", () => {
  assert.equal(searchHelp("").length, helpArticles.length);
  assert.ok(searchHelp("import csv").some(article => article.slug === "import"));
  assert.ok(searchHelp("STOP texts").some(article => article.slug === "text"));
  assert.equal(searchHelp("zebra unicorn").length, 0);
});

test("every help article has a unique address and some words", () => {
  const slugs = new Set(helpArticles.map(article => article.slug));
  assert.equal(slugs.size, helpArticles.length);
  for (const article of helpArticles) assert.ok(article.title && article.body.length > 0, article.slug);
});
