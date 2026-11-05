import assert from "node:assert/strict";
import test from "node:test";
import { hasCrmAccess } from "../src/crm-access.ts";

test("staff and workspace members get the CRM link", () => {
  assert.equal(hasCrmAccess({ platform_role: "owner", workspaces: [] }), true);
  assert.equal(hasCrmAccess({ platform_role: "", workspaces: [{ org_id: "a", roles: ["caller"] }] }), true);
});

test("an account with no staff role and no workspace does not", () => {
  assert.equal(hasCrmAccess({ platform_role: "", workspaces: [] }), false);
  assert.equal(hasCrmAccess({}), false);
  assert.equal(hasCrmAccess(null), false);
  assert.equal(hasCrmAccess(undefined), false);
});
