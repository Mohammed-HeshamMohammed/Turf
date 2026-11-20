import assert from "node:assert/strict";
import test from "node:test";
import { setupStep, TERMS_VERSION, WORK_ROLES, WORK_USES } from "../src/setup.ts";

test("the next step is age, then terms, then work, then nothing", () => {
  assert.equal(setupStep({ age_confirmed: false, terms_accepted: false, work_profile: null }), "age");
  assert.equal(setupStep({ age_confirmed: true, terms_accepted: false, work_profile: null }), "terms");
  assert.equal(setupStep({ age_confirmed: true, terms_accepted: true, work_profile: null }), "work");
  assert.equal(setupStep({ age_confirmed: true, terms_accepted: true, work_profile: { role: "solo_caller" } }), null);
});

test("the owner and cofounder are never asked", () => {
  assert.equal(setupStep({ age_confirmed: false, terms_accepted: false, work_profile: null, setup_exempt: true }), null);
});

test("an older service that sends none of these does not lock anybody out", () => {
  assert.equal(setupStep({}), null);
});

test("the choices are the ones the service accepts", () => {
  assert.ok(TERMS_VERSION);
  assert.deepEqual(WORK_ROLES.map(role => role.key), ["business_owner", "lead_buyer", "call_center", "sales_team", "solo_caller", "data_provider", "other"]);
  assert.equal(WORK_USES.length, 7);
});
