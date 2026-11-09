import test from "node:test";
import assert from "node:assert/strict";
import { preferredWorkspace, readWorkspaceChoice, saveWorkspaceChoice } from "../src/remote/workspace-choice.ts";

test("the most recent allowed workspace wins, with a server fallback", () => {
  const spaces = [{ id: "a" }, { id: "b" }];
  assert.equal(preferredWorkspace(spaces, "a", "2026-11-09T10:00:00Z", { id: "b", at: Date.parse("2026-11-09T11:00:00Z") }), "b");
  assert.equal(preferredWorkspace(spaces, "a", "2026-11-09T12:00:00Z", { id: "b", at: Date.parse("2026-11-09T11:00:00Z") }), "a");
  assert.equal(preferredWorkspace(spaces, "a", null, { id: "removed", at: Date.now() }), "a");
});

test("workspace choices are separate for each account on one device", () => {
  const saved = new Map();
  globalThis.localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value) };
  try {
    saveWorkspaceChoice("person-one", "workspace-b", 123);
    saveWorkspaceChoice("person-two", "workspace-a", 124);
    assert.deepEqual(readWorkspaceChoice("person-one"), { id: "workspace-b", at: 123 });
    assert.deepEqual(readWorkspaceChoice("person-two"), { id: "workspace-a", at: 124 });
  } finally {
    delete globalThis.localStorage;
  }
});
