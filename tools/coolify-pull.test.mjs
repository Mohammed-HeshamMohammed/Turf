import test from "node:test";
import assert from "node:assert/strict";
import { appsOf, pending, pull } from "./coolify-pull.mjs";

const APP = "tdqx7o94epfaiqpp38gqx3ya";
const image = { name: "ghcr.io/mohammed-heshammohammed/cw-crm-web", tag: `sha256-${"a".repeat(64)}`, ref: "x" };
const dep = (id, extra = {}) => ({ id, sha: "abcdef1234", environment: "coolify-pull", creator: { login: "github-actions[bot]" }, payload: { apps: [{ app: APP, image }] }, ...extra });

test("only new deployments recorded by GitHub Actions are pending, oldest first", () => {
  const list = [dep(5), dep(3), dep(9, { creator: { login: "someone" } }), dep(7, { environment: "production" }), dep(2)];
  assert.deepEqual(pending(list, { lastId: 2 }).map(d => d.id), [3, 5]);
});

test("a deployment may only name this repository's images", () => {
  assert.equal(appsOf(dep(1)).length, 1);
  assert.throws(() => appsOf(dep(1, { payload: { apps: [{ app: APP, image: { ...image, name: "ghcr.io/someone-else/cw-crm-web" } }] } })), /outside/);
  assert.throws(() => appsOf(dep(1, { payload: {} })), /short list/);
});

test("each deployment is applied once, in order, and remembered", async () => {
  const applied = [];
  const state = await pull({ deployments: [dep(4), dep(3)], state: { lastId: 2 }, base: "http://l", token: "t", log: () => {}, apply: async () => applied.push(applied.length) });
  assert.deepEqual(state, { lastId: 4, tries: {}, done: {} });
  assert.equal(applied.length, 2);
  const again = await pull({ deployments: [dep(4), dep(3)], state, base: "http://l", token: "t", log: () => {}, apply: async () => applied.push(9) });
  assert.equal(applied.length, 2);
  assert.deepEqual(again, state);
});

test("a failing deployment is retried, stops the queue, and is given up after three tries", async () => {
  const fail = async () => { throw new Error("Coolify is down"); };
  let state = { lastId: 2 };
  for (const tries of [1, 2]) {
    state = await pull({ deployments: [dep(3), dep(4)], state, base: "http://l", token: "t", log: () => {}, apply: fail });
    assert.deepEqual(state, { lastId: 2, tries: { 3: tries }, done: { 3: [] } });
  }
  const order = [];
  state = await pull({ deployments: [dep(3), dep(4)], state, base: "http://l", token: "t", log: () => {}, apply: async apps => { if (order.push(1) === 1) throw new Error("still down"); } });
  assert.deepEqual(state, { lastId: 4, tries: {}, done: {} });
});

test("an application that fails never holds back the others in its deployment, and is the only one retried", async () => {
  const OTHER = "pbhaa90fu9dh3tl2x9kzjdly";
  const two = dep(3, { payload: { apps: [{ app: APP, image }, { app: OTHER, image: { ...image, name: "ghcr.io/mohammed-heshammohammed/cw-crm-core" } }] } });
  const applied = [];
  const apply = async apps => { applied.push(apps[0].app); if (apps[0].app === APP) throw new Error("not set up"); };
  let state = await pull({ deployments: [two], state: { lastId: 2 }, base: "http://l", token: "t", log: () => {}, apply });
  assert.deepEqual(applied, [APP, OTHER]);
  assert.deepEqual(state, { lastId: 2, tries: { 3: 1 }, done: { 3: [OTHER] } });
  state = await pull({ deployments: [two], state, base: "http://l", token: "t", log: () => {}, apply });
  assert.deepEqual(applied, [APP, OTHER, APP]);
  state = await pull({ deployments: [two], state, base: "http://l", token: "t", log: () => {}, apply });
  assert.deepEqual(state, { lastId: 3, tries: {}, done: {} });
});
