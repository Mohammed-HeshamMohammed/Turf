// Build step 5: the web cache. One agency in memory, refreshed on its own, never re-read over open work, and gone at once when the
// person loses access to it.
import test from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../src/remote/engine.ts";
import { MemoryVault } from "../src/remote/vault.ts";
import { ApiError } from "../src/remote/api.ts";
import { dropWork, heldCount, holdWork, screenBusy, takeWork } from "../src/remote/held-work.ts";

const lead = id => ({ id, name: id, stage: "New", verdict: "Unverified", do_not_call: false, assignee_id: "u", team_id: "t", project_id: "p", phone: "", email: "", version: 1, property: {} });
const snap = (ids, revision = 4) => ({ cursor: 10, access_revision: revision, leads: ids.map(lead), tasks: [], notes: [], calls: [], deals: [], handoffs: [] });
const extra = { organizationId: "o", directory: [], teams: [], projects: [] };

test("too far behind while the person is working: the records stay, and are taken again once they are done", async () => {
  let busy = true;
  let snapshots = 0;
  let behind = false;
  const api = {
    snapshot: async () => (snapshots++, snap(snapshots === 1 ? ["a"] : ["a", "b"])),
    push: async () => ({ results: [] }),
    pull: async cursor => (behind ? { reset: true, access_revision: 4 } : { cursor, changes: [], more: false, access_revision: 4 }),
  };
  const engine = new SyncEngine({ vault: new MemoryVault(), api, socket: false, isBusy: () => busy });
  await engine.start(extra);
  await engine.sync();
  behind = true;
  await engine.sync();
  assert.equal(snapshots, 1, "no re-read while typing or on a call");
  assert.equal(engine.behind, true);
  assert.deepEqual(Object.keys(engine.store.leads), ["a"], "what the person is working on stays on screen");
  busy = false;
  behind = false;
  api.pull = async () => ({ reset: true, access_revision: 4 });
  await engine.sync();
  assert.equal(snapshots, 2, "taken again once they are done");
  assert.equal(engine.behind, false);
  assert.deepEqual(Object.keys(engine.store.leads).sort(), ["a", "b"]);
  engine.stop();
});

test("a change of access re-reads at once, even mid-work: nothing the person may no longer see stays", async () => {
  let snapshots = 0;
  const api = {
    snapshot: async () => (snapshots++, snapshots === 1 ? snap(["a", "secret"]) : snap(["a"], 5)),
    push: async () => ({ results: [] }),
    pull: async () => ({ reset: true, access_revision: 5 }),
  };
  const engine = new SyncEngine({ vault: new MemoryVault(), api, socket: false, isBusy: () => true });
  await engine.start(extra);
  await engine.sync();
  assert.equal(snapshots, 2);
  assert.deepEqual(Object.keys(engine.store.leads), ["a"]);
  engine.stop();
});

test("losing access to the open agency clears its records and unsent changes from memory at once", async () => {
  const vault = new MemoryVault();
  let removed = false;
  const api = {
    snapshot: async () => snap(["a"]),
    push: async () => ({ results: [] }),
    pull: async cursor => {
      if (removed) throw new ApiError(403, "not_member", "You are not in this workspace.");
      return { cursor, changes: [], more: false, access_revision: 4 };
    },
  };
  const engine = new SyncEngine({ vault, api, socket: false });
  await engine.start(extra);
  await engine.sync();
  await vault.enqueue({ id: "op1", status: "Rejected" });
  engine.ops = await vault.queue();
  removed = true;
  await engine.sync();
  assert.equal(engine.status, "removed");
  assert.equal(engine.store, null);
  assert.deepEqual(engine.ops, []);
  assert.equal(await vault.get("store"), null);
  assert.deepEqual(await vault.queue(), []);
  engine.stop();
});

test("Reload everything takes the records again from the start, but not over unsent changes", async () => {
  let snapshots = 0;
  const api = { snapshot: async () => (snapshots++, snap(["a"])), push: async () => ({ results: [] }), pull: async cursor => ({ cursor, changes: [], more: false, access_revision: 4 }) };
  const engine = new SyncEngine({ vault: new MemoryVault(), api, socket: false });
  await engine.start(extra);
  await engine.sync();
  await engine.reloadEverything();
  assert.equal(snapshots, 2);
  engine.online = false;
  engine.ops = [{ id: "x", status: "Pending" }];
  await assert.rejects(engine.reloadEverything(), /not sent yet/);
  engine.stop();
});

test("an agency's unsent changes wait in the tab while another agency is open", () => {
  holdWork("o1", [{ id: "1", status: "Pending" }, { id: "2", status: "Conflict" }]);
  holdWork("o2", [{ id: "3", status: "Pending" }]);
  assert.equal(heldCount(), 2, "the warning before closing counts what has not been sent");
  assert.deepEqual(takeWork("o1").map(op => op.id), ["1", "2"]);
  assert.deepEqual(takeWork("o1"), [], "taken once");
  dropWork("o2");
  assert.equal(heldCount(), 0);
});

test("the person counts as busy while typing, with a dialog open, or on a call", () => {
  const doc = (focused, dialog = false) => ({ activeElement: focused, querySelector: () => (dialog ? {} : null) });
  const element = matches => ({ closest: () => (matches ? {} : null) });
  assert.equal(screenBusy(doc(element(true))), true);
  assert.equal(screenBusy(doc(element(false))), false);
  assert.equal(screenBusy(doc(null, true)), true);
  assert.equal(screenBusy(doc(null), true), true, "a call is on");
  assert.equal(screenBusy(undefined), false);
});
