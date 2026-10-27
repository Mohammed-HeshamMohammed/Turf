import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.mjs";
import { latestRelease } from "../src/release.mjs";
import { openStore } from "../src/store.mjs";

let server;
let base;
let store;
let release = async () => ({ available: false });

before(async () => {
  store = openStore();
  server = createApp({ store, release: () => release(), origins: ["http://localhost:5200"] });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  store.close();
});

const post = (path, body) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a waitlist sign-up is saved once", async () => {
  const first = await (await post("/api/waitlist", { email: "A@Example.com", tier: "duo" })).json();
  assert.deepEqual(first, { ok: true, joined: true });
  const again = await (await post("/api/waitlist", { email: "a@example.com" })).json();
  assert.equal(again.joined, false);
  assert.equal(store.waitlistCount(), 1);
});

test("a bad email is refused", async () => {
  const res = await post("/api/waitlist", { email: "nope" });
  assert.equal(res.status, 400);
});

test("the hidden field catches bots without saving", async () => {
  const res = await post("/api/waitlist", { email: "bot@example.com", website: "x" });
  assert.equal(res.status, 200);
  assert.equal(store.waitlistCount(), 1);
});

test("a contact message needs text", async () => {
  assert.equal((await post("/api/contact", { email: "a@example.com", message: "hi" })).status, 400);
  assert.equal((await post("/api/contact", { email: "a@example.com", message: "Call me back please" })).status, 200);
});

test("download answers with the release the function gives", async () => {
  release = async () => ({ available: true, version: "0.1.0" });
  assert.deepEqual(await (await fetch(base + "/api/download")).json(), { available: true, version: "0.1.0" });
});

test("only listed origins get CORS", async () => {
  const ok = await fetch(base + "/healthz", { headers: { origin: "http://localhost:5200" } });
  assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:5200");
  const other = await fetch(base + "/healthz", { headers: { origin: "http://evil.example" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("latestRelease reads GitHub once and caches it", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        tag_name: "desktop-v0.4.0",
        published_at: "2026-10-26T00:00:00Z",
        assets: [
          { name: "latest.json", size: 1, browser_download_url: "u0" },
          { name: "Turf_0.4.0_x64.msi", size: 99, browser_download_url: "u1" },
        ],
      }),
    };
  };
  const get = latestRelease({ repo: "o/r", fetchImpl });
  const a = await get();
  await get();
  assert.equal(calls, 1);
  assert.equal(a.version, "0.4.0");
  assert.equal(a.url, "u1");
  assert.deepEqual(await latestRelease({ repo: "", fetchImpl })(), { available: false });
});

// Last on purpose: it uses up the per-address limit.
test("writes are rate limited per address", async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post("/api/waitlist", { email: `r${i}@example.com` });
  assert.equal(last.status, 429);
});
