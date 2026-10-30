import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createUpdater } from "../src/updates.js";
import { prepareRelease, releaseManifest } from "../scripts/release-manifest.mjs";

test("checking never installs; concurrent checks are coalesced and the resource is released on the next check", async () => {
  let resolve;
  let checks = 0;
  let closed = 0;
  const update = { version: "0.1.5", close: async () => closed++ };
  const updater = createUpdater({
    check: () => {
      checks++;
      return new Promise(done => {
        resolve = done;
      });
    },
  });
  const checking = updater.check(true);
  await updater.check(true);
  assert.equal(checks, 1);
  resolve(update);
  await checking;
  assert.equal(updater.getSnapshot().status, "available");
  assert.equal(updater.getSnapshot().version, "0.1.5");
  const next = updater.check();
  resolve(null);
  await next;
  assert.equal(closed, 1);
  assert.equal(updater.getSnapshot().status, "current");
});

test("offline background checks keep an available update; a manual failure can be retried", async () => {
  let fail = false;
  const updater = createUpdater({
    check: async () => {
      if (fail) throw new Error("offline");
      return { version: "0.1.5" };
    },
  });
  await updater.check();
  fail = true;
  await updater.check();
  assert.equal(updater.getSnapshot().status, "available");
  await updater.check(true);
  assert.equal(updater.getSnapshot().status, "error");
  assert.equal(updater.getSnapshot().version, "0.1.5");
});

test("installation reports progress, waits for download, checks work again and only then installs and restarts", async () => {
  const events = [];
  const updater = createUpdater({
    check: async () => ({
      version: "0.1.5",
      download: async report => {
        events.push("download");
        report({ event: "Started", data: { contentLength: 100 } });
        report({ event: "Progress", data: { chunkLength: 50 } });
        assert.equal(updater.getSnapshot().progress, 50);
        await updater.check();
      },
      install: async () => events.push("install"),
    }),
    restart: async () => events.push("restart"),
    prepareInstall: async () => events.push("stop engine"),
  });
  await updater.check();
  await updater.install(async () => events.push("save"));
  assert.deepEqual(events, ["save", "download", "save", "stop engine", "install", "restart"]);
});

test("a call starting during download blocks installation; retry uses the already downloaded update", async () => {
  let downloads = 0;
  let installs = 0;
  let saves = 0;
  const updater = createUpdater({
    check: async () => ({
      version: "0.1.5",
      download: async () => downloads++,
      install: async () => installs++,
    }),
    restart: async () => {},
  });
  await updater.check();
  await updater.install(async () => {
    if (++saves === 2) throw new Error("Finish the call first");
  });
  assert.equal(installs, 0);
  assert.equal(updater.getSnapshot().error, "Finish the call first");
  await updater.install();
  assert.equal(downloads, 1);
  assert.equal(installs, 1);
});

test("a signature/download failure never installs or restarts and can be retried", async () => {
  let attempts = 0;
  let restarted = false;
  const updater = createUpdater({
    check: async () => ({
      version: "0.1.5",
      download: async () => {
        if (++attempts === 1) throw new Error("Invalid signature");
      },
      install: async () => {},
    }),
    restart: async () => {
      restarted = true;
    },
  });
  await updater.check();
  await updater.install();
  assert.equal(restarted, false);
  assert.equal(updater.getSnapshot().status, "error");
  await updater.install();
  assert.equal(restarted, true);
});

test("the feed identifies a signed, versioned Windows installer with escaped filenames", () => {
  const args = {
    version: "0.1.4",
    repository: "owner/repo",
    installer: "Caller Whale_0.1.4_x64-setup.exe",
    signature: " signed\n",
    date: "2026-10-30T00:00:00Z",
  };
  const manifest = releaseManifest(args);
  assert.equal(manifest.version, "0.1.4");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "signed");
  assert.equal(manifest.platforms["windows-x86_64"].url, "https://github.com/owner/repo/releases/download/crm-v0.1.4/Caller%20Whale_0.1.4_x64-setup.exe");
  assert.throws(() => releaseManifest({ ...args, signature: "" }), /signed/);
  assert.throws(() => releaseManifest({ ...args, version: "0.1.4-beta" }), /stable/);
});

test("release preparation preserves signed bytes and uses filenames GitHub will keep unchanged", () => {
  const folder = mkdtempSync(join(tmpdir(), "callerwhale-release-"));
  try {
    writeFileSync(join(folder, "Caller Whale_0.1.4_x64-setup.exe"), "signed installer bytes");
    writeFileSync(join(folder, "Caller Whale_0.1.4_x64-setup.exe.sig"), "signature");
    const manifest = prepareRelease(pathToFileURL(folder + "/"), { version: "0.1.4", repository: "owner/repo" });
    const name = "CallerWhale_0.1.4_x64-setup.exe";
    assert.equal(manifest.platforms["windows-x86_64"].url, `https://github.com/owner/repo/releases/download/crm-v0.1.4/${name}`);
    assert.equal(readFileSync(join(folder, name), "utf8"), "signed installer bytes");
    assert.equal(readFileSync(join(folder, name + ".sig"), "utf8"), manifest.platforms["windows-x86_64"].signature);
    assert.deepEqual(JSON.parse(readFileSync(join(folder, "latest.json"), "utf8")), manifest);
    assert.equal(prepareRelease(pathToFileURL(folder + "/"), { version: "0.1.4", repository: "owner/repo" }).version, "0.1.4");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
