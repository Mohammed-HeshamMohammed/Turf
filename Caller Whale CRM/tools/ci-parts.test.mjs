import test from "node:test";
import assert from "node:assert/strict";
import { PARTS, partsFor } from "./ci-parts.mjs";

test("a change runs its part and what depends on it", () => {
  assert.deepEqual(partsFor(["Caller Whale CRM/services/crm-core/main.go"]), ["crm-core"]);
  assert.deepEqual(partsFor(["Caller Whale CRM/services/crm-core/migrations/0049_x.sql"]), ["crm-core", "importing-lists"]);
  assert.deepEqual(partsFor(["Caller Whale CRM/services/auth/help.go"]), ["auth", "gateway"]);
  assert.deepEqual(partsFor(["service/x.py"]).sort(), ["crm-app", "desktop-app", "older-app", "skip-engine"]);
});

test("docs alone run nothing; CI files, main and manual runs run everything", () => {
  assert.deepEqual(partsFor(["Caller Whale CRM/docs/plans/x.md", "README.md"]), []);
  assert.deepEqual(partsFor([".github/workflows/ci.yml"]), Object.keys(PARTS));
  assert.deepEqual(partsFor([], { all: true }), Object.keys(PARTS));
});
