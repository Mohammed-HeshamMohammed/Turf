import assert from "node:assert/strict";
import test from "node:test";
import { paramOf, wantsCrm } from "../src/links.ts";

test("a value is read from the query string", () => {
  assert.equal(paramOf("?email=a%40b.com", "email"), "a@b.com");
  assert.equal(paramOf("", "email"), "");
});

test("only next=app means the CRM is waiting", () => {
  assert.equal(wantsCrm("?next=app"), true);
  assert.equal(wantsCrm("?next=https://evil.example"), false);
  assert.equal(wantsCrm(""), false);
});
