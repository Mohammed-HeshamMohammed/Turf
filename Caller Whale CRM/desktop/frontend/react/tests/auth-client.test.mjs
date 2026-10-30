// The CRM's side of signing in with the auth service: the pieces that run without a browser.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { invitationToken, socketProtocols } from "../src/remote/api.js";

test("an invitation link or a bare token both give the token", () => {
  assert.equal(invitationToken("https://callerwhale.example/#/join?token=abc123"), "abc123");
  assert.equal(invitationToken("  https://callerwhale.example/#/join?token=a%2Bb&x=1 "), "a+b");
  assert.equal(invitationToken("abc123"), "abc123");
  assert.equal(invitationToken(""), "");
});

test("the live-events socket carries the token and organization in its protocols", () => {
  assert.deepEqual(socketProtocols("a.b.c", "org-1"), ["callerwhale.v1", "bearer.a.b.c", "org.org-1"]);
  assert.deepEqual(socketProtocols(null, ""), ["callerwhale.v1"]);
});

test("this copy of the auth client matches the original in services/auth/clients", () => {
  const sync = join(import.meta.dirname, "..", "..", "..", "..", "services", "auth", "clients", "sync.mjs");
  execFileSync(process.execPath, [sync, "--check"], { stdio: "pipe" });
});
