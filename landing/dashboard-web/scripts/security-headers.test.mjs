import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "./security-headers.mjs";

test("CRM CSP permits its gateway WebSocket without permitting inline scripts", () => {
  const headers = securityHeaders("https://auth.callerwhale.com", "https://gate.callerwhale.com");
  assert.match(headers, /connect-src[^;]*https:\/\/gate\.callerwhale\.com wss:\/\/gate\.callerwhale\.com/);
  assert.match(headers, /script-src 'self'[^;]*;/);
  assert.doesNotMatch(headers, /script-src[^;]*'unsafe-inline'/);
});
