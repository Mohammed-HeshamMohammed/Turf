import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { BADGE_STYLE, authOrigin, securityHeaders } from "../scripts/security-headers.mjs";

test("the policy permits auth, reCAPTCHA, and Cloudflare's injected beacon", () => {
  const headers = securityHeaders("https://auth.callerwhale.com");
  assert.match(headers, /connect-src 'self' https:\/\/auth\.callerwhale\.com https:\/\/gate\.callerwhale\.com https:\/\/www\.google\.com\/recaptcha\/;/);
  assert.match(headers, /script-src 'self' https:\/\/www\.google\.com\/recaptcha\/ https:\/\/www\.gstatic\.com\/recaptcha\/ https:\/\/static\.cloudflareinsights\.com;/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /default-src 'none'/);
  assert.doesNotMatch(headers, /unsafe-eval|script-src[^;]*unsafe-inline/);
});

test("the contact API origin must be safe", () => {
  assert.throws(() => securityHeaders("https://auth.callerwhale.com", "http://gate.callerwhale.com"), /VITE_CALLERWHALE_GATEWAY_URL/);
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

test("the one inline style the page makes is allowed by its hash, and is still what the human check writes", () => {
  assert.ok(readFileSync(new URL("../src/auth/human-check.jsx", import.meta.url), "utf8").includes(BADGE_STYLE));
  assert.match(securityHeaders("https://auth.callerwhale.com"), /style-src 'self' 'sha256-CybIssPtAts0iFZtkYuubemEprrtHjzE2orsUue9Cbc=';/);
});
