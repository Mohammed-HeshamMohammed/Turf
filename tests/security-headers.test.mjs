import assert from "node:assert/strict";
import test from "node:test";
import { authOrigin, securityHeaders } from "../scripts/security-headers.mjs";

test("the policy lets the page talk to the auth service and nobody else", () => {
  const headers = securityHeaders("https://auth.callerwhale.com");
  assert.match(headers, /connect-src 'self' https:\/\/auth\.callerwhale\.com;/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /default-src 'none'/);
  assert.doesNotMatch(headers, /unsafe-eval|script-src[^;]*unsafe-inline/);
});

test("a trailing slash is fine, but only the origin goes into the policy", () => {
  assert.equal(authOrigin("https://auth.callerwhale.com/"), "https://auth.callerwhale.com");
});

test("the build stops on a missing or unsafe auth address", () => {
  for (const bad of [undefined, "", "auth.callerwhale.com", "http://auth.callerwhale.com", "https://auth.callerwhale.com/v1", "https://auth.callerwhale.com/?a=1", "https://user:pw@auth.callerwhale.com", "javascript:alert(1)"]) {
    assert.throws(() => securityHeaders(bad), /VITE_CALLERWHALE_AUTH_URL/, String(bad));
  }
});

test("a local address is allowed over http, for trying the image on this computer", () => {
  assert.equal(authOrigin("http://localhost:8101"), "http://localhost:8101");
});
