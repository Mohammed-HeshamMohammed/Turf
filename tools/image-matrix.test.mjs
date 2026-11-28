import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildArgs, matrix } from "./image-matrix.mjs";

const config = JSON.parse(readFileSync(new URL("./production.json", import.meta.url), "utf8"));

test("every deployed branch has its images; the desktop branches have none", () => {
  const list = matrix(config);
  const names = list.map(i => i.image);
  assert.equal(new Set(names).size, names.length, "image names are unique");
  for (const name of ["cw-gateway", "cw-crm-core", "cw-dialer-sms", "cw-website", "cw-crm-web", "cw-grafana-proxy", "cw-alert-relay", "cw-loki"]) assert.ok(names.includes(name), name);
  assert.ok(!list.some(i => i.branch === "desktop-app-production" || i.branch === "skip-engine-production"));
  for (const i of list) assert.match(i.dockerfile, /(^|\/)Dockerfile(\.(merge|outbox|phone-api|phone-webhooks|phone-jobs|sms-api|sms-webhooks|sms-jobs))?$/); // crm-core's job containers have their own (split 2)
});

test("moved images name their Coolify application and setting; the rest have none (step 48)", () => {
  const list = matrix(config);
  const moved = list.filter(i => i.coolify);
  assert.deepEqual(moved.map(i => [i.image, i.setting]).sort(), [["cw-alert-relay", "CW_ALERT_RELAY_IMAGE"], ["cw-assistant", ""], ["cw-auth", ""], ["cw-authz", ""], ["cw-billing", ""], ["cw-crm-core", ""], ["cw-crm-merge", ""], ["cw-crm-outbox", ""], ["cw-crm-web", ""], ["cw-dialer-sms", ""], ["cw-gateway", ""], ["cw-grafana-proxy", "CW_GRAFANA_PROXY_IMAGE"], ["cw-importing-lists", ""], ["cw-importing-worker", ""], ["cw-learning", ""], ["cw-live", ""], ["cw-mcp", ""], ["cw-messaging", ""], ["cw-notifications", ""], ["cw-website", ""]]);
  for (const i of list.filter(i => !i.coolify)) assert.equal(i.setting, "");
});

test("build arguments come from the Actions variables, and a missing one is named", () => {
  assert.deepEqual(buildArgs("A=X,B=Y", { X: " https://a.test\n", Y: "" }), { lines: ["A=https://a.test", "B="], missing: ["Y"] });
  assert.deepEqual(buildArgs("", {}), { lines: [], missing: [] });
});

test("a variable marked with ? may be left unset: its argument stays empty and nothing is reported missing", () => {
  assert.deepEqual(buildArgs("A=X?,B=Y", { X: "", Y: "y" }), { lines: ["A=", "B=y"], missing: [] });
  assert.deepEqual(buildArgs("A=X?", { X: "https://dialer.test" }), { lines: ["A=https://dialer.test"], missing: [] });
});

test("the CRM web image takes the dialer and Option B settings, all optional", () => {
  const web = matrix(config).find(i => i.image === "cw-crm-web");
  for (const pair of ["VITE_CALLERWHALE_DIALER_URL=CALLERWHALE_DIALER_URL?", "VITE_CALLERWHALE_REAL_CALL_NUMBERS=CALLERWHALE_REAL_CALL_NUMBERS?", "VITE_CALLERWHALE_REAL_CALL_FROM=CALLERWHALE_REAL_CALL_FROM?"]) assert.ok(web.args.split(",").includes(pair), pair);
});
