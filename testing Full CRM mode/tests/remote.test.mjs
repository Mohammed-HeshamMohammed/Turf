import test from "node:test";
import assert from "node:assert/strict";
import { seedState } from "../src/data.js";
import { applyChanges, collectionsFromStore, isoFromLocal, labelFor, localParts, operationFor, roleKey, storeFromSnapshot } from "../src/remote/translate.js";
import { remoteReducer, syncAction } from "../src/remote/session.js";

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
  assert.deepEqual(localParts(null), ["", ""]);
  assert.equal(roleKey(["owner", "admin"]), "owner");
  assert.equal(roleKey(["admin"]), "admin");
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
