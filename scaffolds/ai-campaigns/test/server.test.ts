import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createApp, route } from "../src/server.ts";

let server: Server;
let base = "";

before(async () => {
  server = createApp();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

test("health names the service", async () => {
  const res = await fetch(base + "/healthz");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "ai-campaigns" });
});

test("version is reported", () => {
  assert.deepEqual(route("GET", "/version").body, { service: "ai-campaigns", version: "0.1.0" });
});

test("unknown paths are not found", async () => {
  assert.equal((await fetch(base + "/nope")).status, 404);
  assert.equal(route("POST", "/healthz").status, 404);
});
