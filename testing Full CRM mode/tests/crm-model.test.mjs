import test from "node:test";
import assert from "node:assert/strict";
import { CALL_DAYS, CALL_TREND, seedState } from "../src/data.js";
import { canEditLead, loadState, personalProfile, reducer, visibleLeads, visibleTasks, visibleThreads } from "../src/model.js";

const as = role => ({ ...seedState(), role });
test("personal details persist per account without renaming lead responsibility", () => {
  const caller = as("caller");
  const changed = reducer(caller, { type: "PERSONAL", profile: { name: "Maya C.", taskReminders: false } });
  assert.equal(personalProfile(changed).name, "Maya C.");
  assert.equal(changed.leads.find(lead => lead.id === "l01").assignee, "Maya Chen");
  const closer = reducer(changed, { type: "ROLE", role: "closer" });
  assert.equal(personalProfile(closer).name, "Alex Rivera");
  assert.equal(personalProfile(closer).taskReminders, true);
  const restored = reducer(loadState({ getItem: () => JSON.stringify(closer) }), { type: "ROLE", role: "caller" });
  assert.equal(personalProfile(restored).taskReminders, false);
  assert.equal(personalProfile(restored).name, "Maya C.");
});
test("interval detail preserves the daily sample counts and contact totals", () => {
  assert.equal(CALL_TREND.length, 42);
  const dailyCalls = [18, 25, 16, 9, 32, 28, 37];
  const dailyReached = [7, 12, 8, 3, 16, 13, 21];
  CALL_DAYS.forEach((day, index) => {
    const intervals = CALL_TREND.filter(point => point.day === day);
    assert.equal(intervals.length, 6);
    assert.equal(
      intervals.reduce((sum, point) => sum + point.calls, 0),
      dailyCalls[index],
    );
    assert.equal(
      intervals.reduce((sum, point) => sum + point.reached, 0),
      dailyReached[index],
    );
  });
  assert(CALL_TREND.every(point => point.reached <= point.calls));
  assert.equal(new Set(CALL_TREND.map(point => point.slot)).size, 42);
});
test("role scopes keep admin, client, and caller records distinct", () => {
  assert.equal(visibleLeads(as("admin")).length, 0);
  assert(visibleLeads(as("client")).every(lead => lead.shared));
  assert(visibleTasks(as("client")).every(task => task.shared));
  assert(visibleThreads(as("client")).every(thread => thread.shared));
  assert.equal(
    visibleThreads(as("client")).some(thread => thread.channel === "SMS"),
    false,
  );
  assert(visibleLeads(as("caller")).every(lead => lead.assignee === "Maya Chen"));
  assert.equal(visibleLeads(as("owner")).length, seedState().leads.length);
  assert.equal(canEditLead(as("caller"), "l03"), false);
  assert.equal(
    reducer(as("client"), { type: "UPDATE_LEAD", id: "l01", change: { stage: "Closed" } }).leads.find(lead => lead.id === "l01").stage,
    "Interested",
  );
});
test("handoff keeps ownership until the recipient accepts, and acceptance is idempotent", () => {
  const requested = reducer(as("caller"), { type: "HANDOFF", id: "l01", to: "Alex Rivera", note: "Ready to discuss a flexible close." });
  const handoff = requested.handoffs[0];
  assert.equal(requested.leads.find(lead => lead.id === "l01").assignee, "Maya Chen");
  assert.equal(reducer(requested, { type: "ACCEPT", id: handoff.id }), requested);
  const closer = reducer(requested, { type: "ROLE", role: "closer" });
  assert(visibleLeads(closer).some(lead => lead.id === "l01"));
  assert.equal(canEditLead(closer, "l01"), false);
  const accepted = reducer(closer, { type: "ACCEPT", id: handoff.id });
  assert.equal(accepted.leads.find(lead => lead.id === "l01").assignee, "Alex Rivera");
  assert.equal(accepted.deals.filter(deal => deal.leadId === "l01").length, 1);
  assert.equal(reducer(accepted, { type: "ACCEPT", id: handoff.id }), accepted);
  assert.equal(reducer({ ...closer, online: false }, { type: "ACCEPT", id: handoff.id }).handoffs[0].status, "Requested");
});
test("offline changes persist and sync retains conflicts, drafts, and other people operations", () => {
  const state = { ...as("caller"), online: false };
  const noted = reducer(state, { type: "NOTE", id: "l01", text: "Call tomorrow", visibility: "internal" });
  assert.equal(noted.queue.length, 1);
  const storage = { getItem: () => JSON.stringify(noted) };
  assert.equal(
    loadState(storage)
      .leads.find(lead => lead.id === "l01")
      .notes.at(-1).text,
    "Call tomorrow",
  );
  const mixed = {
    ...noted,
    online: true,
    queue: [
      { id: "other", actor: "Alex Rivera", kind: "Note", status: "Pending" },
      ...noted.queue,
      { id: "draft", actor: "Maya Chen", kind: "Communication draft", status: "Pending" },
      { id: "second", actor: "Maya Chen", kind: "Task", status: "Pending" },
    ],
  };
  const conflicted = reducer(mixed, { type: "CONFLICT" });
  assert.equal(conflicted.queue[0].status, "Pending");
  assert.equal(conflicted.queue[1].status, "Conflict");
  const synced = reducer(conflicted, { type: "SYNC" });
  assert.deepEqual(
    synced.queue.map(item => item.id),
    ["other", noted.queue[0].id, "draft"],
  );
  assert.equal(reducer(synced, { type: "RESOLVE", id: "other", discard: true }).queue.length, 3);
  const reviewed = reducer(synced, { type: "RESOLVE", id: noted.queue[0].id });
  assert.deepEqual(
    reducer(reviewed, { type: "SYNC" }).queue.map(item => item.id),
    ["other", "draft"],
  );
});
test("blocked contacts cannot be logged as called and client comments stay shared", () => {
  const caller = as("caller");
  assert.equal(reducer(caller, { type: "CALL", id: "l07", outcome: "Reached" }), caller);
  const client = as("client");
  assert.equal(reducer(client, { type: "MESSAGE", id: "m01", text: "Do not share seller messages" }), client);
  assert.equal(reducer(client, { type: "NOTE", id: "l02", text: "Private record" }), client);
  const commented = reducer(client, { type: "NOTE", id: "l01", text: "Please update the brief", visibility: "internal" });
  assert.equal(commented.leads.find(lead => lead.id === "l01").notes.at(-1).visibility, "shared");
  assert.equal(loadState({ getItem: () => "{broken" }).schema, 1);
});
