// The CRM's side of signing in with the auth service: the pieces that run without a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { socketProtocols } from "../src/remote/api.ts";

test("the live-events socket carries the token and organization in its protocols", () => {
  assert.deepEqual(socketProtocols("a.b.c", "org-1"), ["callerwhale.v1", "bearer.a.b.c", "org.org-1"]);
  assert.deepEqual(socketProtocols(null, ""), ["callerwhale.v1"]);
});

