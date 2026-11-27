import assert from "node:assert/strict";
import test from "node:test";
import { mayCallForReal } from "../src/realCall.ts";

const numbers = ["+201001234567"];

test("only the team's listed phones get a real call, in any spelling", () => {
  assert.equal(mayCallForReal("+20 100 123 4567", { numbers, token: "t" }), true);
  assert.equal(mayCallForReal("+1 (813) 555-0001", { numbers, token: "t" }), false);
});

test("no login token on this device means no real call", () => {
  assert.equal(mayCallForReal("+201001234567", { numbers, token: "" }), false);
});

test("an empty list (the normal build) means no real call", () => {
  assert.equal(mayCallForReal("+201001234567", { numbers: [], token: "t" }), false);
});
