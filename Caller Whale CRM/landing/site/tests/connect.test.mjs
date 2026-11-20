import assert from "node:assert/strict";
import test from "node:test";
import { askedFrom, returnKind } from "../src/connect-check.ts";

test("the well-known assistants are recognised by where they return, not by name", () => {
  assert.equal(returnKind("claude.ai"), "known");
  assert.equal(returnKind("chatgpt.com"), "known");
  assert.equal(returnKind("gemini.google.com"), "known");
  assert.equal(returnKind("claude.ai.evil.example"), "unknown");
  assert.equal(returnKind("evilclaude.ai"), "unknown");
  assert.equal(returnKind("localhost:6274"), "local");
});

test("a request without its parts is not treated as one", () => {
  assert.equal(askedFrom("?client_id=a"), null);
  assert.ok(askedFrom("?client_id=a&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&code_challenge=x"));
});

test("other Google hosts, where anyone can publish pages, are not trusted", () => {
  assert.equal(returnKind("script.google.com"), "unknown");
  assert.equal(returnKind("sites.google.com"), "unknown");
});
