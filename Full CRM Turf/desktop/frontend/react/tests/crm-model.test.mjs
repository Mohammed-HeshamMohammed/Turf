import test from "node:test";
import assert from "node:assert/strict";
import { CALL_DAYS, CALL_OUTCOMES, CALL_TREND, TODAY, seedState } from "../src/data.js";
import { callbackLabel, canEditLead, loadState, personalProfile, reducer, visibleLeads, visibleTasks, visibleThreads } from "../src/model.js";

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
  assert.equal(loadState({ getItem: () => "{broken" }).schema, 2);
});
test("ReadyMode call outcomes keep every call and schedule the next one", () => {
  const caller = as("caller");
  assert.deepEqual(
    CALL_OUTCOMES.map(item => item.code),
    ["Trans", "CB", "NI", "Lang", "VM", "NA", "Dead", "W#", "DNC"],
  );
  assert.equal(reducer(caller, { type: "CALL", id: "l01", outcome: "Reached" }), caller, "only known outcomes are recorded");
  const before = caller.leads.find(lead => lead.id === "l01");
  const voicemail = reducer(caller, { type: "CALL", id: "l01", outcome: "Voicemail" });
  const left = voicemail.leads.find(lead => lead.id === "l01");
  assert.equal(left.calls.length, before.calls.length + 1);
  assert.deepEqual([left.calls.at(-1).outcome, left.calls.at(-1).code, left.calls.at(-1).agent], ["Voicemail", "VM", "Maya Chen"]);
  assert.equal(left.callbackDate, "2026-10-16");
  assert.equal(left.calls.at(-1).scheduled, "2026-10-16T" + before.callback);
  const callbacks = voicemail.tasks.filter(task => task.leadId === "l01" && task.type === "Callback" && !task.done);
  assert.equal(callbacks.length, 1, "a new try replaces the open callback task");
  assert.equal(callbacks[0].date, "2026-10-16");

  assert.equal(reducer(caller, { type: "CALL", id: "l02", outcome: "Callback" }), caller, "a callback needs a time");
  const asked = reducer(caller, { type: "CALL", id: "l02", outcome: "Callback", callbackAt: "2026-10-20T09:15" });
  const michael = asked.leads.find(lead => lead.id === "l02");
  assert.deepEqual([michael.callbackDate, michael.callback], ["2026-10-20", "09:15"]);
  assert.equal(callbackLabel(michael.callbackDate, michael.callback), "Oct 20, 09:15");
  assert.equal(callbackLabel(TODAY, "10:30"), "Today, 10:30");

  const notInterested = reducer(caller, { type: "CALL", id: "l04", outcome: "Not interested" }).leads.find(lead => lead.id === "l04");
  assert.deepEqual([notInterested.stage, notInterested.callbackDate], ["Contacted", "2027-01-13"]);

  const wrong = reducer(caller, { type: "CALL", id: "l02", outcome: "Wrong number" });
  assert.equal(wrong.leads.find(lead => lead.id === "l02").verdict, "Wrong number");
  assert.equal(wrong.leads.find(lead => lead.id === "l02").callback, "");
  assert.equal(wrong.tasks.filter(task => task.leadId === "l02" && task.type === "Callback" && !task.done).length, 0);

  const blocked = reducer(caller, { type: "CALL", id: "l01", outcome: "Do not call" });
  const sarah = blocked.leads.find(lead => lead.id === "l01");
  assert.deepEqual([sarah.verdict, sarah.stage, sarah.callback], ["Do not call", "Closed", ""]);
  assert.equal(reducer(blocked, { type: "CALL", id: "l01", outcome: "Voicemail" }), blocked);
});
test("a transfer qualifies the lead and books an appointment task", () => {
  const caller = as("caller");
  const transferred = reducer(caller, { type: "CALL", id: "l02", outcome: "Transfer" });
  const lead = transferred.leads.find(item => item.id === "l02");
  assert.deepEqual([lead.stage, lead.sentTo, lead.callback], ["Qualified", "Appointments", ""]);
  assert.ok(transferred.tasks.some(task => task.leadId === "l02" && task.type === "Appointment" && task.date === TODAY));
});
test("a saved schema 1 workspace gains empty call history and today's callback dates", () => {
  const old = { ...seedState(), schema: 1 };
  for (const lead of old.leads) {
    delete lead.calls;
    delete lead.callbackDate;
  }
  const loaded = loadState({ getItem: () => JSON.stringify(old) });
  assert.equal(loaded.schema, 2);
  assert.deepEqual(loaded.leads[0].calls, []);
  assert.equal(loaded.leads[0].callbackDate, TODAY);
  assert.equal(loaded.leads.find(lead => !lead.callback).callbackDate, "");
});

test("leads can be archived, restored and deleted for good, and the pieces go with them", () => {
  const manager = as("manager");
  const target = manager.leads.find(lead => lead.team === "Tampa");
  const archived = reducer(manager, { type: "ARCHIVE_LEAD", id: target.id });
  assert.equal(
    visibleLeads(archived).some(lead => lead.id === target.id),
    false,
  );
  assert.equal(archived.leads.find(lead => lead.id === target.id).archived, true);
  assert.equal(reducer(archived, { type: "DELETE_LEAD", id: "nobody" }), archived);
  const restored = reducer(archived, { type: "RESTORE_LEAD", id: target.id });
  assert.equal(
    visibleLeads(restored).some(lead => lead.id === target.id),
    true,
  );
  // Only an archived lead can be deleted, and its tasks, deals and notes are removed with it.
  assert.equal(reducer(restored, { type: "DELETE_LEAD", id: target.id }), restored);
  const gone = reducer(archived, { type: "DELETE_LEAD", id: target.id });
  assert.equal(
    gone.leads.some(lead => lead.id === target.id),
    false,
  );
  assert.equal(
    gone.tasks.some(task => task.leadId === target.id),
    false,
  );
  assert.equal(
    gone.deals.some(deal => deal.leadId === target.id),
    false,
  );
});

test("tasks, deals and notes can be changed and removed by the people allowed to", () => {
  const manager = as("manager");
  const task = visibleTasks(manager)[0];
  const renamed = reducer(manager, { type: "UPDATE_TASK", id: task.id, change: { title: "  New title ", time: "08:15" } });
  assert.deepEqual([renamed.tasks.find(item => item.id === task.id).title, renamed.tasks.find(item => item.id === task.id).time], ["New title", "08:15"]);
  assert.equal(reducer(manager, { type: "UPDATE_TASK", id: task.id, change: { title: "   " } }), manager);
  assert.equal(
    reducer(manager, { type: "DELETE_TASK", id: task.id }).tasks.some(item => item.id === task.id),
    false,
  );
  // A deal opens for a lead and is removed again; a role without finance cannot.
  const lead = visibleLeads(manager)[0];
  const deal = { id: "deal-new", leadId: lead.id, stage: "Appointment", amount: 100000, fee: 5000, closeDate: "2026-12-01" };
  const opened = reducer(manager, { type: "NEW_DEAL", deal });
  assert.equal(
    opened.deals.some(item => item.id === "deal-new"),
    true,
  );
  assert.equal(
    reducer(opened, { type: "DELETE_DEAL", id: "deal-new" }).deals.some(item => item.id === "deal-new"),
    false,
  );
  assert.equal(reducer(as("caller"), { type: "NEW_DEAL", deal }).deals.length, as("caller").deals.length);
  // Notes: the author or someone who can edit the lead may change or delete them.
  const withNote = reducer(manager, { type: "NOTE", leadId: lead.id, text: "First version" });
  const note = withNote.leads.find(item => item.id === lead.id).notes.at(-1);
  const edited = reducer(withNote, { type: "EDIT_NOTE", leadId: lead.id, noteId: note.id, text: "Second version" });
  assert.deepEqual(edited.leads.find(item => item.id === lead.id).notes.at(-1), { ...note, text: "Second version", edited: true });
  assert.equal(
    reducer(withNote, { type: "DELETE_NOTE", leadId: lead.id, noteId: note.id })
      .leads.find(item => item.id === lead.id)
      .notes.some(item => item.id === note.id),
    false,
  );
});
test("a saved engine check gives visible leads their verdicts and keeps do-not-call", () => {
  const owner = as("owner");
  const list = owner.leads.find(lead => lead.verdict === "Do not call")?.datasetId || owner.leads[0].datasetId;
  const inList = owner.leads.filter(lead => lead.datasetId === list);
  const verdicts = Object.fromEntries(inList.map(lead => [lead.id, "Ready to call"]));
  const other = owner.leads.find(lead => lead.datasetId !== list);
  verdicts[other.id] = "Wrong number";
  const checked = reducer(owner, { type: "CHECK", id: list, verdicts });
  for (const lead of checked.leads.filter(item => item.datasetId === list)) {
    const before = inList.find(item => item.id === lead.id);
    assert.equal(lead.verdict, before.verdict === "Do not call" ? "Do not call" : "Ready to call");
  }
  assert.equal(checked.leads.find(lead => lead.id === other.id).verdict, other.verdict, "another list is never changed");
  assert.equal(checked.datasets.find(item => item.id === list).status, "Checked");
  // A demo check changes no verdict.
  const demo = reducer(owner, { type: "CHECK", id: list, verdicts: null });
  assert.deepEqual(
    demo.leads.map(lead => lead.verdict),
    owner.leads.map(lead => lead.verdict),
  );
  // A role without data access cannot save a check at all.
  const caller = as("caller");
  assert.equal(reducer(caller, { type: "CHECK", id: list, verdicts }), caller);
});
test("a workspace read back from storage replaces the sample one, and anything else is ignored", () => {
  const sample = seedState();
  const big = { ...sample, leads: Array.from({ length: 25000 }, (_, index) => ({ ...sample.leads[0], id: "big" + index })) };
  const restored = reducer(sample, { type: "HYDRATE", state: big });
  assert.equal(restored.leads.length, 25000);
  assert.equal(reducer(sample, { type: "HYDRATE", state: { schema: 2, leads: "nope" } }), sample);
  assert.equal(reducer(sample, { type: "HYDRATE", state: null }), sample);
  // Schema 1 workspaces are brought up to date on the way in.
  const old = reducer(sample, { type: "HYDRATE", state: { ...sample, schema: 1, leads: [{ ...sample.leads[0], calls: undefined, callback: "09:00" }] } });
  assert.equal(old.schema, 2);
});
test("correcting a mapping teaches Caller Whale that header for later lists", () => {
  const owner = as("owner");
  const dataset = { id: "dx", name: "Odd list", columns: ["Owner", "Development", "Digits"], team: "Tampa" };
  const lead = { ...owner.leads[0], id: "lx", datasetId: "dx", sourceValues: { Owner: "Mona Adel", Development: "Palm Grove", Digits: "(813) 274-6610" } };
  const imported = reducer(owner, { type: "IMPORT", dataset, leads: [lead] });
  const saved = reducer(imported, { type: "SOURCE_MAPPING", id: "dx", mappings: { name: "Owner", phone: "Digits", subdivision: "Development" } });
  assert.equal(saved.settings.learnedHeaders.development, "subdivision");
  assert.equal(saved.settings.learnedHeaders.digits, undefined, "Caller Whale found Digits by itself, so there was nothing to learn");
  assert.equal(saved.leads.find(item => item.id === "lx").subdivision, "Palm Grove");
});
test("a lead's place is kept; an exact address is never replaced by a ZIP centre", () => {
  const owner = as("owner");
  const id = owner.leads[0].id;
  const zip = reducer(owner, { type: "LOCATE", places: { [id]: { lat: 27.95, lng: -82.45, precision: "zip" } } });
  assert.deepEqual(zip.leads[0].geo, { lat: 27.95, lng: -82.45, precision: "zip" });
  const exact = reducer(zip, { type: "LOCATE", places: { [id]: { lat: 27.96, lng: -82.46, precision: "address" } } });
  assert.equal(exact.leads[0].geo.precision, "address");
  const again = reducer(exact, { type: "LOCATE", places: { [id]: { lat: 1, lng: 1, precision: "zip" } } });
  assert.equal(again.leads[0].geo.lat, 27.96, "a ZIP centre does not move an exact place");
  const missed = reducer(zip, { type: "LOCATE", places: {}, notFound: [id] });
  assert.equal(missed.leads[0].geo.notFound, true);
  assert.equal(missed.leads[0].geo.precision, "zip", "it stays in its ZIP area");
  assert.equal(reducer(owner, { type: "LOCATE", places: { [id]: { lat: "x", lng: 2 } } }).leads[0].geo, undefined);
});
