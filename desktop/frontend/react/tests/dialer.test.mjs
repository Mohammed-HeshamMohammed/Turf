import assert from "node:assert/strict";
import test from "node:test";
import { seedState } from "../src/data.js";
import { dialerTarget, dialNumberKey } from "../src/dialer.js";

test("typed numbers match lead phone formats without creating a new record", () => {
  const state = seedState();
  const leadCount = state.leads.length;
  assert.equal(dialNumberKey("(813) 555-0101"), dialNumberKey("+1 (813) 555-0101"));
  assert.notEqual(dialNumberKey("+8135550101"), dialNumberKey("8135550101"), "an explicit country prefix must not be rewritten as a local US number");
  assert.equal(dialerTarget(state, "8135550101").lead.id, "l01");
  const manual = dialerTarget(state, "+44 20 7946 0123");
  assert.equal(manual.lead.adHoc, true);
  assert.equal(state.leads.length, leadCount);
  assert(dialerTarget(state, "123").error);
});

test("the dial pad preserves blocked numbers and role scope", () => {
  const state = seedState();
  assert(dialerTarget(state, state.leads.find(item => item.verdict === "Do not call").phone).error);
  const caller = { ...state, role: "caller" };
  assert(dialerTarget(caller, state.leads.find(item => item.assignee === "Alex Rivera").phone).error);
  assert(dialerTarget({ ...state, role: "client" }, "+44 20 7946 0123").error);
});
