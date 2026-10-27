// node --test tools/gen-infra.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { everything } from "./gen-infra.mjs";

const config = JSON.parse(readFileSync(new URL("./infra.json", import.meta.url), "utf8"));
const out = everything(config);

test("the files on disk are what the table produces", () => {
  for (const [path, text] of Object.entries(out)) {
    assert.equal(readFileSync(new URL(`../infra/k8s/${path}`, import.meta.url), "utf8"), text, path);
  }
});

test("every part runs as a non-root user, with probes and limits, spread over machines", () => {
  for (const s of config.services) {
    const d = out[`${s.name}/deployment.yaml`];
    assert.match(d, /runAsNonRoot: true/, s.name);
    assert.ok(d.includes(`runAsUser: ${s.uid}
`), s.name);
    assert.match(d, /readinessProbe:[\s\S]*livenessProbe:/, s.name);
    assert.match(d, /limits: \{ cpu:/, s.name);
    assert.match(d, /allowPrivilegeEscalation: false/, s.name);
    assert.match(d, /topologyKey: kubernetes.io\/hostname/, s.name);
  }
});

test("parts that scale have an autoscaler and never lose their last copy; the single-copy part is replaced, not rolled", () => {
  for (const s of config.services) {
    const scales = s.replicas.max > s.replicas.min;
    assert.equal(`${s.name}/hpa.yaml` in out, scales, s.name);
    assert.equal(`${s.name}/pdb.yaml` in out, s.replicas.min > 1, s.name);
    // With an autoscaler the Deployment leaves the count to it.
    assert.equal(/^  replicas:/m.test(out[`${s.name}/deployment.yaml`]), !scales, s.name);
  }
  assert.match(out["landing-api/deployment.yaml"], /type: Recreate/);
  assert.match(out["core-api/deployment.yaml"], /maxUnavailable: 0/);
});

test("secrets are named, never written in", () => {
  for (const [path, text] of Object.entries(out)) assert.doesNotMatch(text, /password|secret:\s*\S+=|BEGIN [A-Z ]*KEY/i, path);
  assert.match(out["core-api/deployment.yaml"], /secretRef:\n\s+name: core-api-env/);
});
