import test from "node:test";
import assert from "node:assert/strict";
import { PARTS, partsFor } from "./ci-parts.mjs";

test("a change runs its part and what depends on it", () => {
  assert.deepEqual(partsFor(["services/crm-core/main.go"]), ["crm-core", "tools"]);
  assert.deepEqual(partsFor(["services/crm-core/migrations/0049_x.sql"]), ["crm-core", "importing-worker", "tools"]);
  assert.deepEqual(partsFor(["services/auth/help.go"]), ["auth", "gateway", "tools"]);
  assert.deepEqual(partsFor(["packages/calendar/calendar.jsx"]), ["tools", "crm-app", "website"]);
  assert.deepEqual(partsFor(["package-lock.json"]), ["crm-app", "website"]);
  assert.deepEqual(partsFor(["engines/skip-engine/x.py"]), ["crm-app"]);
  // The desktop apps have their own workflows.
  assert.deepEqual(partsFor(["apps/crm-desktop/src/main.rs", "apps/lists-desktop/src/App.tsx"]), []);
});

test("docs alone run nothing; CI files, main and manual runs run everything", () => {
  assert.deepEqual(partsFor(["docs/plans/x.md", "README.md"]), []);
  assert.deepEqual(partsFor([".github/workflows/ci.yml"]), Object.keys(PARTS));
  assert.deepEqual(partsFor([], { all: true }), Object.keys(PARTS));
});
