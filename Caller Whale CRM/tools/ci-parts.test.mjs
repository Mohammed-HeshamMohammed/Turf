import test from "node:test";
import assert from "node:assert/strict";
import { PARTS, partsFor } from "./ci-parts.mjs";

test("a change runs its part and what depends on it", () => {
  assert.deepEqual(partsFor(["Caller Whale CRM/services/crm-core/main.go"]), ["crm-core", "tools"]);
  assert.deepEqual(partsFor(["Caller Whale CRM/services/crm-core/migrations/0049_x.sql"]), ["crm-core", "importing-lists", "tools"]);
  assert.deepEqual(partsFor(["Caller Whale CRM/services/auth/help.go"]), ["auth", "gateway", "tools"]);
  assert.deepEqual(partsFor(["Caller Whale CRM/shared/calendar/calendar.jsx"]), ["tools", "crm-app", "website", "desktop-app", "older-app"]);
  assert.deepEqual(partsFor(["service/x.py"]).sort(), ["crm-app", "desktop-app", "older-app", "skip-engine"]);
});

test("docs alone run nothing; CI files, main and manual runs run everything", () => {
  assert.deepEqual(partsFor(["Caller Whale CRM/docs/plans/x.md", "README.md"]), []);
  assert.deepEqual(partsFor([".github/workflows/ci.yml"]), Object.keys(PARTS));
  assert.deepEqual(partsFor([], { all: true }), Object.keys(PARTS));
});
