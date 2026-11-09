import test from "node:test";
import assert from "node:assert/strict";
import { seedState } from "../src/data.ts";
import { applyChanges, collectionsFromStore, isoFromLocal, labelFor, localParts, operationFor, roleKey, storeFromSnapshot } from "../src/remote/translate.ts";
import { remoteReducer, syncAction } from "../src/remote/session.ts";
import { SyncEngine } from "../src/remote/engine.ts";
import { MemoryVault } from "../src/remote/vault.ts";
import { mergeAuthProfile } from "../src/remote/profile.ts";
import { personalProfile } from "../src/model.ts";
import { loadPersonalPreferences, savePersonalPreferences } from "../src/personal-preferences.ts";

const directory = [
  { id: "u-maya", name: "Maya Chen" },
  { id: "u-alex", name: "Alex Rivera" },
];
const serverLead = {
  id: "lead-1",
  name: "Sarah Johnson",
  stage: "Contacted",
  verdict: "Unverified",
  do_not_call: false,
  assignee_id: "u-maya",
  team_id: "t1",
  project_id: "p1",
  next_action_at: isoFromLocal("2026-10-16", "10:30"),
  phone: "+17165553101",
  email: "",
  value_amount: "245000.00",
  shared_external: false,
  version: 3,
  property: { address: "1842 Palm Avenue", city: "Tampa", region: "FL", postal_code: "33610" },
};
const snapshot = {
  cursor: 10,
  access_revision: 4,
  offline_lease_expires_at: "2026-10-17T00:00:00Z",
  leads: [serverLead],
  tasks: [
    {
      id: "task-1",
      lead_id: "lead-1",
      title: "Callback: Sarah Johnson",
      type: "Callback",
      priority: "Normal",
      due_at: serverLead.next_action_at,
      assignee_id: "u-maya",
      done_at: null,
    },
  ],
  notes: [{ id: "n1", lead_id: "lead-1", body: "Open to an offer", visibility: "internal", author_label: "Maya Chen", occurred_at: "2026-10-14T16:04:00Z" }],
  calls: [{ id: "c1", lead_id: "lead-1", outcome: "Voicemail", code: "VM", agent_label: "Maya Chen", occurred_at: "2026-10-14T15:00:00Z", scheduled_at: null }],
  deals: [],
  handoffs: [],
};

test("server records become prototype records with local callback times", () => {
  const store = storeFromSnapshot(snapshot, { directory, teams: [{ id: "t1", name: "Tampa" }], projects: [{ id: "p1", name: "Tampa absentee owners" }] });
  const { leads, tasks, datasets } = collectionsFromStore(store);
  assert.equal(leads[0].assignee, "Maya Chen");
  assert.equal(leads[0].team, "Tampa");
  assert.deepEqual([leads[0].callbackDate, leads[0].callback], ["2026-10-16", "10:30"]);
  assert.equal(leads[0].value, 245000);
  assert.equal(leads[0].calls[0].code, "VM");
  assert.equal(leads[0].notes[0].text, "Open to an offer");
  assert.equal(tasks[0].assignee, "Maya Chen");
  assert.equal(datasets[0].rows, 1);
  assert.equal(collectionsFromStore(store).activities[0].text, "Added a note");
  assert.deepEqual(localParts(null), ["", ""]);
  assert.equal(roleKey(["owner", "admin"]), "owner");
  assert.equal(roleKey(["admin"]), "admin");
});

test("connected identity and empty server projects remain visible", () => {
  const state = remoteReducer(seedState(), { type: "REMOTE_START", role: "owner", remote: { user: { name: "Real Owner", email: "real@callerwhale.com" }, capabilities: ["import"], organization: "Real workspace" } });
  assert.equal(personalProfile(state).email, "real@callerwhale.com");
  assert.equal(personalProfile(state).name, "Real Owner");
  const store = storeFromSnapshot({ ...snapshot, leads: [], calls: [], notes: [] }, { projects: [{ id: "empty", name: "Empty list" }] });
  assert.deepEqual(collectionsFromStore(store).datasets.map(item => item.name), ["Empty list"]);
});

test("CRM profile follows the auth account and ignores a different account", () => {
  const account = { id: "u-owner", name: "Mohammed Hesham", email: "owner@callerwhale.com", avatar: "data:image/png;base64,abc", phone: "+201234567890", first_name: "Mohammed", last_name: "Hesham" };
  const coreUser = { id: "u-owner", name: "Old name", email: "owner@callerwhale.com" };
  const state = remoteReducer(seedState(), { type: "REMOTE_START", role: "owner", remote: { user: mergeAuthProfile(coreUser, account), capabilities: [], organization: "Workspace" } });
  assert.deepEqual([personalProfile(state).name, personalProfile(state).avatar, personalProfile(state).phone], [account.name, account.avatar, account.phone]);
  const changed = remoteReducer(state, { type: "REMOTE_PROFILE", profile: { ...account, name: "Updated name" } });
  assert.equal(personalProfile(changed).name, "Updated name");
  const refused = remoteReducer(changed, { type: "REMOTE_PROFILE", profile: { ...account, id: "another-user", name: "Wrong account" } });
  assert.equal(personalProfile(refused).name, "Updated name");
});

test("connected preferences survive a restart and stay with the signed-in account", () => {
  const records = new Map();
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
  assert.equal(savePersonalPreferences("u-one", { taskReminders: false, startPage: "tasks", reduceMotion: true, name: "Never store" }, storage), true);
  assert.equal(records.size, 1);
  assert.equal(records.values().next().value.includes("Never store"), false);
  const preferences = loadPersonalPreferences("u-one", storage);
  const user = { id: "u-one", name: "A", email: "a@example.com" };
  const start = remoteReducer(seedState(), { type: "REMOTE_START", role: "owner", remote: { user, capabilities: [], organization: "Workspace" }, preferences });
  assert.equal(personalProfile(start).taskReminders, false);
  assert.equal(personalProfile(start).startPage, "tasks");
  const changed = remoteReducer(start, { type: "PERSONAL", profile: { handoffReminders: false } });
  savePersonalPreferences(user.id, personalProfile(changed), storage);
  const restarted = remoteReducer(seedState(), { type: "REMOTE_START", role: "owner", remote: { user, capabilities: [], organization: "Workspace" }, preferences: loadPersonalPreferences(user.id, storage) });
  assert.equal(personalProfile(restarted).handoffReminders, false);
  assert.equal(loadPersonalPreferences("u-two", storage).handoffReminders, true);
  assert.equal(loadPersonalPreferences("u-two", storage).startPage, "dashboard");
});

test("one device copy is replaced on a workspace switch after its queue is clear", async () => {
  const vault = new MemoryVault();
  await vault.put("store", { organizationId: "old", cursor: 1, leads: { stale: { id: "stale" } } });
  const api = { snapshot: async () => ({ ...snapshot, leads: [] }), pull: async () => ({ cursor: 10, changes: [], more: false }) };
  const engine = new SyncEngine({ vault, api, socket: false });
  await engine.start({ organizationId: "new", directory: [], teams: [], projects: [] });
  assert.equal(engine.store.organizationId, "new");
  assert.deepEqual(Object.keys(engine.store.leads), []);
  engine.stop();

  await vault.put("store", { organizationId: "old", cursor: 1 });
  await vault.enqueue({ id: "pending", status: "Pending" });
  const guarded = new SyncEngine({ vault, api, socket: false });
  await assert.rejects(guarded.start({ organizationId: "new" }), /pending changes/);
  assert.equal((await vault.get("store")).organizationId, "old");
  guarded.stop();

  await vault.remove("pending");
  const unavailable = new SyncEngine({ vault, api: { snapshot: async () => { throw new Error("network unavailable"); } }, socket: false });
  await assert.rejects(unavailable.start({ organizationId: "new" }), /network unavailable/);
  assert.equal((await vault.get("store")).organizationId, "old", "an unavailable new workspace leaves the existing offline copy intact");
  unavailable.stop();
});

test("pulled changes replace records and removals take a lead's children with it", () => {
  const store = storeFromSnapshot(snapshot, { directory });
  const moved = applyChanges(store, [{ entity: "lead", id: "lead-1", op: "upsert", record: { ...serverLead, property: undefined, stage: "Qualified" } }]);
  assert.equal(moved.leads["lead-1"].stage, "Qualified");
  assert.equal(moved.leads["lead-1"].property.address, "1842 Palm Avenue", "a pulled lead keeps its property");
  const gone = applyChanges(store, [{ entity: "lead", id: "lead-1", op: "remove" }]);
  assert.deepEqual([Object.keys(gone.leads), Object.keys(gone.tasks), Object.keys(gone.notes)], [[], [], []]);
});

test("prototype actions become operations with the values the person edited from", () => {
  const store = storeFromSnapshot(snapshot, { directory });
  const before = { ...seedState(), online: true, ...collectionsFromStore(store), threads: [] };
  const stage = operationFor({ type: "UPDATE_LEAD", id: "lead-1", change: { stage: "Interested" } }, before, store);
  assert.equal(stage.kind, "lead.update");
  assert.deepEqual(stage.payload, { id: "lead-1", changes: { stage: "Interested" }, base: { stage: "Contacted" } });
  const callback = operationFor({ type: "UPDATE_LEAD", id: "lead-1", change: { callbackDate: "2026-10-20" } }, before, store);
  assert.equal(callback.payload.changes.next_action_at, isoFromLocal("2026-10-20", "10:30"));
  assert.equal(callback.payload.base.next_action_at, serverLead.next_action_at);
  const assign = operationFor({ type: "UPDATE_LEAD", id: "lead-1", change: { assignee: "Alex Rivera" } }, before, store);
  assert.deepEqual([assign.kind, assign.online, assign.payload.assignee_id], ["lead.assign", true, "u-alex"]);
  const call = operationFor({ type: "CALL", leadId: "lead-1", outcome: "Callback", callbackAt: "2026-10-20T09:15" }, before, store);
  assert.equal(call.payload.callback_at, new Date("2026-10-20T09:15").toISOString());
  assert.equal(labelFor(call, before), "Call outcome: Callback · Sarah Johnson");
  const offline = operationFor({ type: "NOTE", leadId: "lead-1", text: " hi " }, { ...before, online: false }, store);
  assert.deepEqual([offline.queued_offline, offline.payload.body], [true, "hi"]);
  assert.equal(operationFor({ type: "PERSONAL", profile: {} }, before, store), null);
});

test("pending changes replay over each new server state until confirmed", () => {
  const store = storeFromSnapshot(snapshot, { directory });
  let state = remoteReducer(seedState(), {
    type: "REMOTE_START",
    role: "caller",
    remote: { user: { name: "Maya Chen" }, capabilities: ["edit", "call"], organization: "Oak & Palm" },
  });
  assert.equal(state.leads.length, 0);
  const note = { type: "NOTE", leadId: "lead-1", text: "Pending note" };
  const ops = [{ id: "op-1", kind: "note.add", payload: { lead_id: "lead-1" }, status: "Pending", action: note, label: "Note · Sarah Johnson" }];
  state = remoteReducer(state, syncAction({ store, ops, online: true, status: "synced", error: "" }, "Maya Chen"));
  assert.equal(state.settings.workspace, "Oak & Palm");
  assert.equal(state.leads[0].notes.at(-1).text, "Pending note");
  assert.equal(state.queue[0].label, "Note · Sarah Johnson");
  // Once confirmed (the queue is empty and the server copy has the note), nothing is replayed twice.
  const confirmed = {
    ...store,
    notes: {
      ...store.notes,
      n2: { id: "n2", lead_id: "lead-1", body: "Pending note", visibility: "internal", author_label: "Maya Chen", occurred_at: "2026-10-15T10:00:00Z" },
    },
  };
  state = remoteReducer(state, syncAction({ store: confirmed, ops: [], online: true, status: "synced", error: "" }, "Maya Chen"));
  assert.equal(state.leads[0].notes.filter(item => item.text === "Pending note").length, 1);
  assert.equal(remoteReducer(state, { type: "REMOTE_END" }).remote, undefined);
});

test("deals and task edits become server operations with what the person edited from", () => {
  const store = storeFromSnapshot(
    { ...snapshot, deals: [{ id: "deal-1", lead_id: "lead-1", stage: "Offer sent", amount: "250000.00", fee: "12000.00", close_date: "2026-11-03" }] },
    { directory },
  );
  const before = { ...seedState(), online: true, ...collectionsFromStore(store), threads: [] };
  const created = operationFor(
    { type: "NEW_DEAL", deal: { id: "deal-2", leadId: "lead-1", stage: "Appointment", amount: 260000, fee: 14000, closeDate: "2026-12-01" } },
    before,
    store,
  );
  assert.deepEqual(
    [created.kind, created.payload],
    ["deal.create", { id: "deal-2", lead_id: "lead-1", stage: "Appointment", amount: 260000, fee: 14000, close_date: "2026-12-01" }],
  );
  const removal = operationFor({ type: "DELETE_DEAL", id: "deal-1" }, before, store);
  assert.deepEqual([removal.kind, removal.online, removal.payload], ["deal.delete", true, { id: "deal-1" }]);
  const edit = operationFor(
    { type: "UPDATE_TASK", id: "task-1", change: { title: " Call again ", assignee: "Alex Rivera", date: "2026-10-22" } },
    before,
    store,
  );
  assert.equal(edit.kind, "task.update");
  assert.deepEqual(edit.payload.changes, { title: "Call again", assignee_id: "u-alex", due_at: isoFromLocal("2026-10-22", "10:30") });
  assert.deepEqual(edit.payload.base, { title: "Callback: Sarah Johnson", assignee_id: "u-maya", due_at: serverLead.next_action_at });
  const gone = operationFor({ type: "DELETE_TASK", id: "task-1" }, before, store);
  assert.deepEqual([gone.kind, gone.online, gone.payload], ["task.delete", true, { id: "task-1" }]);
  assert.equal(operationFor({ type: "UPDATE_TASK", id: "task-1", change: {} }, before, store), null);
  assert.equal(labelFor(gone, before), "Task removal");
});

test("removing a lead against a server is one online-only operation", () => {
  const store = storeFromSnapshot(snapshot, { directory });
  const before = { ...seedState(), online: true, ...collectionsFromStore(store), threads: [] };
  const removal = operationFor({ type: "DELETE_LEAD", id: "lead-1" }, before, store);
  assert.deepEqual([removal.kind, removal.online, removal.payload], ["lead.delete", true, { id: "lead-1" }]);
  assert.equal(labelFor(removal, before), "Lead removal · Sarah Johnson");
  assert.equal(operationFor({ type: "DELETE_LEAD", id: "nobody" }, before, store), null);
});

test("archiving, restoring and note changes become server operations, and the server's marks come back", () => {
  const archivedLead = { ...serverLead, archived_at: "2026-10-20T10:00:00Z" };
  const store = storeFromSnapshot({ ...snapshot, leads: [archivedLead], notes: [{ ...snapshot.notes[0], edited_at: "2026-10-20T10:05:00Z" }] }, { directory });
  const before = { ...seedState(), online: true, ...collectionsFromStore(store), threads: [] };
  assert.equal(before.leads[0].archived, true);
  assert.equal(before.leads[0].notes[0].edited, true);
  assert.deepEqual(operationFor({ type: "RESTORE_LEAD", id: "lead-1" }, before, store).kind, "lead.restore");
  assert.deepEqual(operationFor({ type: "ARCHIVE_LEAD", id: "lead-1" }, before, store).payload, { id: "lead-1" });
  const edit = operationFor({ type: "EDIT_NOTE", leadId: "lead-1", noteId: "n1", text: " Better " }, before, store);
  assert.deepEqual([edit.kind, edit.payload], ["note.edit", { id: "n1", body: "Better" }]);
  const removal = operationFor({ type: "DELETE_NOTE", leadId: "lead-1", noteId: "n1" }, before, store);
  assert.deepEqual([removal.kind, removal.online], ["note.delete", true]);
  const back = operationFor({ type: "RESTORE_NOTE", leadId: "lead-1", note: { id: "n1", text: "Open to an offer", visibility: "internal" } }, before, store);
  assert.deepEqual([back.kind, back.payload.id, back.payload.body], ["note.add", "n1", "Open to an offer"]);
});
