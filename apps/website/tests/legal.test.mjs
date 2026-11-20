import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseLegal, versionOf } from "../src/legal.ts";

const read = name => readFileSync(new URL(`../src/legal/${name}.md`, import.meta.url), "utf8");

test("headings, lists, tables, bold, links and placeholders are read", () => {
  const blocks = parseLegal("# Title\n\nVersion 2026-01-01 text **bold** and [a link](/terms) and [LEGAL NAME].\n\n## Part\n\n- one\n- two\n\n1. first\n2. second\n\n| A | B |\n|---|---|\n| x | y |\n");
  assert.deepEqual(blocks.map(block => block.kind), ["h1", "p", "h2", "ul", "ol", "table"]);
  assert.deepEqual(blocks[1].inline.map(part => part.kind), ["text", "bold", "text", "link", "text", "placeholder", "text"]);
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[5].rows.length, 1);
});

test("every legal text has a version, and they all carry the same one as the terms version the service asks people to accept", () => {
  const versions = ["terms", "privacy", "dpa", "acceptable-use"].map(name => versionOf(read(name)));
  assert.ok(versions.every(version => /^\d{4}-\d{2}-\d{2}$/.test(version)) && new Set(versions).size === 1, versions.join(", "));
  const setup = readFileSync(new URL("../src/setup.ts", import.meta.url), "utf8");
  assert.ok(setup.includes(`TERMS_VERSION = "${versions[0]}"`), "setup.ts TERMS_VERSION must match the legal texts' version");
});

test("what the texts promise about the learning copy matches the code's limits", () => {
  const privacy = read("privacy");
  for (const kept of ["one-way codes", "different for every workspace", "Never sold, shared or licensed", "2 years"]) assert.ok(privacy.includes(kept), kept);
  for (const never of ["name, phone number, email, street address"]) assert.ok(privacy.includes(never), never);
});
