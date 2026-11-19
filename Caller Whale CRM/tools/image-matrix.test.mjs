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
  for (const i of list) assert.match(i.dockerfile, /(^|\/)Dockerfile$/);
});

test("build arguments come from the Actions variables, and a missing one is named", () => {
  assert.deepEqual(buildArgs("A=X,B=Y", { X: " https://a.test\n", Y: "" }), { lines: ["A=https://a.test", "B="], missing: ["Y"] });
  assert.deepEqual(buildArgs("", {}), { lines: [], missing: [] });
});
