import assert from "node:assert/strict";
import test from "node:test";
import { redirectFor } from "../src/guard.ts";

test("nothing is decided while the sign-in state is unknown", () => {
  for (const path of ["/", "/signin", "/signup", "/forgot", "/account", "/dashboard"]) assert.equal(redirectFor(path, undefined), null);
});

test("someone signed in is sent away from the sign-in pages", () => {
  for (const path of ["/signin", "/signup", "/forgot", "/signin/"]) assert.equal(redirectFor(path, { email: "a@example.com" }), "/dashboard");
});

test("nobody signed in is sent from the account page to sign in", () => {
  assert.equal(redirectFor("/account", null), "/signin");
  assert.equal(redirectFor("/account/", null), "/signin");
  assert.equal(redirectFor("/dashboard", null), "/signin");
});

test("every other page stays as it is", () => {
  assert.equal(redirectFor("/", null), null);
  assert.equal(redirectFor("/", { email: "a@example.com" }), null);
  assert.equal(redirectFor("/signin", null), null);
  assert.equal(redirectFor("/account", { email: "a@example.com" }), null);
  assert.equal(redirectFor("/anything-else", null), null);
});

test("signed in but the second step is not done: stay on sign-in, and nothing behind it opens", () => {
  const waiting = { email: "a@example.com", mfa_enrolled: true, mfa_passed: false };
  assert.equal(redirectFor("/signin", waiting), null);
  assert.equal(redirectFor("/dashboard", waiting), "/signin");
  assert.equal(redirectFor("/account", waiting), "/signin");
  assert.equal(redirectFor("/signup", waiting), "/signin");
  const done = { email: "a@example.com", mfa_enrolled: true, mfa_passed: true };
  assert.equal(redirectFor("/signin", done), "/dashboard");
});
