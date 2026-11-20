import assert from "node:assert/strict";
import test from "node:test";
import { PLATFORM_ROLES, WORKSPACE_ROLES, mergeRoles, platformRoleName, prettyRole, workspaceRoleName } from "../src/roles.ts";

test("the word owner means two different things, so each group names it its own way", () => {
  assert.equal(platformRoleName("owner"), "Platform owner");
  assert.equal(workspaceRoleName("owner"), "Agency owner");
  assert.notEqual(platformRoleName("owner"), workspaceRoleName("owner"));
});

test("a role is listed once, however many lists mention it", () => {
  const merged = mergeRoles(WORKSPACE_ROLES, [{ key: "caller", name: "Caller (server)" }, { key: "senior_closer", name: "Senior closer" }], [{ key: "senior_closer", name: "Senior closer" }]);
  const keys = merged.map(role => role.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(merged.length, WORKSPACE_ROLES.length + 1);
  assert.equal(merged.find(role => role.key === "caller")?.name, "Caller (server)");
});

test("a custom role gets words from its key, and the staff roles stay in their own group", () => {
  assert.equal(prettyRole("senior_closer"), "Senior closer");
  assert.equal(workspaceRoleName("senior_closer"), "Senior closer");
  assert.deepEqual(PLATFORM_ROLES.map(role => role.key), ["owner", "cofounder", "system_admin", "tester"]);
  assert.equal(workspaceRoleName("cofounder"), "Cofounder");
});
