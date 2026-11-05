import assert from "node:assert/strict";
import test from "node:test";
import { namePartsOf, splitName } from "../src/person-name.ts";

test("a display name is split into first, middle and last", () => {
  assert.deepEqual(splitName("Mohammed Hesham"), { first: "Mohammed", middle: "", last: "Hesham" });
  assert.deepEqual(splitName("  Mohammed  Ali Hesham "), { first: "Mohammed", middle: "Ali", last: "Hesham" });
  assert.deepEqual(splitName("Mohammed"), { first: "Mohammed", middle: "", last: "" });
  assert.deepEqual(splitName(""), { first: "", middle: "", last: "" });
});

test("saved parts win over splitting the display name", () => {
  assert.deepEqual(namePartsOf({ name: "Ana Maria de la Cruz", first_name: "Ana Maria", middle_name: "", last_name: "de la Cruz" }), { first: "Ana Maria", middle: "", last: "de la Cruz" });
  assert.deepEqual(namePartsOf({ name: "Ana Cruz" }), { first: "Ana", middle: "", last: "Cruz" });
});
