import assert from "node:assert/strict";
import test from "node:test";
import { redirectFor } from "../src/guard.js";

test("nothing is decided while the sign-in state is unknown", () => {
  for (const path of ["/", "/signin", "/signup", "/forgot", "/account"]) assert.equal(redirectFor(path, undefined), null);
});

test("someone signed in is sent away from the sign-in pages", () => {
  for (const path of ["/signin", "/signup", "/forgot", "/signin/"]) assert.equal(redirectFor(path, { email: "a@example.com" }), "/account");
});

test("nobody signed in is sent from the account page to sign in", () => {
  assert.equal(redirectFor("/account", null), "/signin");
  assert.equal(redirectFor("/account/", null), "/signin");
});

test("every other page stays as it is", () => {
  assert.equal(redirectFor("/", null), null);
  assert.equal(redirectFor("/", { email: "a@example.com" }), null);
  assert.equal(redirectFor("/signin", null), null);
  assert.equal(redirectFor("/account", { email: "a@example.com" }), null);
  assert.equal(redirectFor("/anything-else", null), null);
});
