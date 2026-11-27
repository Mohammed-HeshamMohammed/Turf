import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "./security-headers.mjs";

test("CRM CSP permits its gateway WebSocket without permitting inline scripts", () => {
  const headers = securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com");
  assert.match(headers, /connect-src[^;]*https:\/\/gate\.callerwhale\.com wss:\/\/gate\.callerwhale\.com/);
  assert.match(headers, /script-src 'self'[^;]*;/);
  assert.doesNotMatch(headers, /script-src[^;]*'unsafe-inline'/);
});

test("CRM CSP lets the app call the dialer when one is configured, and only then", () => {
  const withDialer = securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com", { dialerUrl: "https://dialer.callerwhale.com" });
  assert.match(withDialer, /connect-src[^;]* https:\/\/dialer\.callerwhale\.com/);
  const without = securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com");
  assert.doesNotMatch(without, /dialer\.callerwhale\.com/);
});

test("CRM CSP refuses a dialer address with a path", () => {
  assert.throws(() => securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com", { dialerUrl: "https://dialer.callerwhale.com/api" }), /VITE_CALLERWHALE_DIALER_URL/);
});

test("CRM CSP allows Telnyx's signalling server only in a build with real calls", () => {
  const real = securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com", { realCalls: true });
  assert.match(real, /connect-src[^;]* wss:\/\/rtc\.telnyx\.com/);
  assert.doesNotMatch(securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com"), /telnyx/);
});
