import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deploy, plan, readRecords, checkApps, record, PULL_ENVIRONMENT } from "./coolify-deploy.mjs";

const APP = "cs7nxvwhusacrlrsmolbqll9";
const d = n => `sha256:${String(n).repeat(64)}`;
const rec = (image, setting, digest = d(1), coolify = APP) => ({ image, setting, digest, coolify, ref: `ghcr.io/owner/${image}` });

test("images are grouped by Coolify application, one deploy each", () => {
  const other = "otherappid12345678901234";
  assert.deepEqual(plan([rec("cw-b", "B_IMAGE", d(2)), rec("cw-a", "A_IMAGE"), rec("cw-c", "C_IMAGE", d(3), other)]), [
    {
      app: APP,
      settings: [
        { key: "A_IMAGE", value: `ghcr.io/owner/cw-a@${d(1)}`, image: "cw-a" },
        { key: "B_IMAGE", value: `ghcr.io/owner/cw-b@${d(2)}`, image: "cw-b" },
      ],
    },
    { app: other, settings: [{ key: "C_IMAGE", value: `ghcr.io/owner/cw-c@${d(3)}`, image: "cw-c" }] },
  ]);
  assert.deepEqual(plan([]), []);
  assert.deepEqual(plan([{ image: "cw-x", coolify: "" }]), []);
});

test("an image application gets its image by digest", () => {
  assert.deepEqual(plan([rec("cw-a", "")]), [
    { app: APP, image: { name: "ghcr.io/owner/cw-a", tag: `sha256-${"1".repeat(64)}`, ref: `ghcr.io/owner/cw-a@${d(1)}` } },
  ]);
  assert.throws(() => plan([rec("cw-a", ""), rec("cw-b", "")]), /one image/);
  assert.throws(() => plan([rec("cw-a", ""), rec("cw-b", "B_IMAGE")]), /both/);
});

test("an image application is pointed at the new image, then deployed", async () => {
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push(`${init.method} ${url.replace("https://c.test/api/v1", "")} ${init.body ?? ""}`);
      return { status: 200, text: async () => "{}" };
    },
    () => deploy(plan([rec("cw-a", "")]), { base: "https://c.test", token: "t", log: () => {} }),
  );
  assert.deepEqual(calls, [
    `PATCH /applications/${APP} {"docker_registry_image_name":"ghcr.io/owner/cw-a","docker_registry_image_tag":"sha256-${"1".repeat(64)}"}`,
    `POST /deploy?uuid=${APP}&force=false `,
  ]);
});

test("bad records stop the deploy", () => {
  assert.throws(() => plan([rec("cw-a", "A_IMAGE", "latest")]), /digest/);
  assert.throws(() => plan([rec("cw-a", "a image")]), /setting/);
  assert.throws(() => plan([rec("cw-a", "A_IMAGE", d(1), "x/../y")]), /application id/);
  assert.throws(() => plan([{ ...rec("cw-a", "A_IMAGE"), ref: "docker.io/evil/cw-a" }]), /image name/);
  assert.throws(() => plan([rec("cw-a", "A_IMAGE"), rec("cw-b", "A_IMAGE")]), /two images/);
});

test("records are read from the downloaded artifact folders; a missing folder is no records", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploys-"));
  mkdirSync(join(dir, "deploy-cw-a"));
  writeFileSync(join(dir, "deploy-cw-a", "cw-a.json"), JSON.stringify(rec("cw-a", "A_IMAGE")));
  assert.deepEqual(readRecords(dir), [rec("cw-a", "A_IMAGE")]);
  assert.deepEqual(readRecords(join(dir, "nope")), []);
});

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("each setting is written, created when missing, then the application deploys once", async () => {
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push(`${init.method} ${url.replace("https://c.test/api/v1", "")} ${init.headers.Authorization}`);
      return { status: init.method === "PATCH" && init.body.includes("B_IMAGE") ? 404 : 200, text: async () => "{}" };
    },
    () => deploy(plan([rec("cw-a", "A_IMAGE"), rec("cw-b", "B_IMAGE")]), { base: "https://c.test", token: "t", log: () => {} }),
  );
  assert.deepEqual(calls, [
    `PATCH /applications/${APP}/envs Bearer t`,
    `PATCH /applications/${APP}/envs Bearer t`,
    `POST /applications/${APP}/envs Bearer t`,
    `POST /deploy?uuid=${APP}&force=false Bearer t`,
  ]);
});

test("a refused setting stops before deploying", async () => {
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push(init.method);
      return { status: 401, text: async () => "no" };
    },
    () => assert.rejects(deploy(plan([rec("cw-a", "A_IMAGE")]), { base: "https://c.test", token: "t", log: () => {} }), /401/),
  );
  assert.deepEqual(calls, ["PATCH"]);
});

test("Cloudflare's challenge page is named, not shown as a Coolify refusal", async t => {
  t.mock.method(globalThis, "fetch", async () => ({ status: 403, text: async () => "<!DOCTYPE html><title>Just a moment...</title>" }));
  await assert.rejects(deploy(plan([rec("cw-a", "")]), { base: "https://c.test", token: "t", log: () => {} }), /Cloudflare's bot protection answered instead of Coolify .*localhost/);
});

test("a plan read back from GitHub is checked again before it touches Coolify", () => {
  const ok = plan([rec("cw-a", ""), rec("cw-b", "B_IMAGE", d(2), "bbbbbbbbbbbbbbbbbbbbbbbb")]);
  assert.equal(checkApps(ok), ok);
  assert.throws(() => checkApps([]), /short list/);
  assert.throws(() => checkApps([{ app: "x" }]), /application id/);
  assert.throws(() => checkApps([{ app: APP, image: { name: "docker.io/evil/cw-a", tag: "sha256-" + "a".repeat(64) } }]), /unexpected image/);
  assert.throws(() => checkApps([{ app: APP, settings: [{ key: "PATH", value: "x" }] }]), /unexpected setting/);
  assert.throws(() => checkApps([{ app: APP }]), /nothing to set/);
});

test("the approved plan is recorded as a GitHub deployment for the server's puller", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization }); return { status: 201, text: async () => JSON.stringify({ id: 42 }) }; });
  const apps = plan([rec("cw-a", "")]);
  assert.equal(await record(apps, { repo: "o/r", sha: "abc", token: "gh", log: () => {} }), 42);
  assert.equal(calls[0].url, "https://api.github.com/repos/o/r/deployments");
  assert.equal(calls[0].auth, "Bearer gh");
  assert.deepEqual({ ...calls[0].body, description: undefined }, { ref: "abc", environment: PULL_ENVIRONMENT, auto_merge: false, required_contexts: [], payload: { apps }, description: undefined });
  // Then marked handed over, so GitHub does not show it as queued for good.
  assert.equal(calls[1].url, "https://api.github.com/repos/o/r/deployments/42/statuses");
  assert.equal(calls[1].body.state, "success");
  assert.equal(calls[1].body.auto_inactive, true);
});
