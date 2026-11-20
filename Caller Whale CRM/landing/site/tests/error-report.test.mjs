import assert from "node:assert/strict";
import test from "node:test";
import { framesOf, reportFor } from "../src/error-report.ts";

test("a report keeps the kind, page and code places, never the error's text (D303)", () => {
  const error = new TypeError("Cannot read Pat Seller 512-555-0101");
  error.stack = "TypeError: Cannot read Pat Seller 512-555-0101\n    at x (https://callerwhale.com/assets/index-abc.js:12:345)\n    at y (https://callerwhale.com/assets/vendor.js:1:2)";
  const report = reportFor(error, "/dashboard", "site", "1.4.2");
  assert.deepEqual(report, { app: "site", kind: "TypeError", page: "/dashboard", where: ["https://callerwhale.com/assets/index-abc.js:12:345", "https://callerwhale.com/assets/vendor.js:1:2"], version: "1.4.2" });
  assert.ok(!JSON.stringify(report).includes("Pat"));
  assert.equal(reportFor("a thrown string", "/", "site", "x").kind, "Error");
  assert.deepEqual(framesOf(undefined), []);
});
