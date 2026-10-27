import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLES, seedState } from "../src/data.js";
import { reducer, restoreState, visibleThreads } from "../src/model.js";
import { smsRecipient } from "../src/sms.js";
import { callDuration, visibleCallLog } from "../src/callLog.js";
import { beginDemoCall, clearCallOutcome, endDemoCall, getCallSession, subscribeCallLog } from "../src/callSession.js";

const phone = "+1 (202) 555-0199";
const thread = { id: "number-thread", leadId: null, phone, channel: "SMS", unread: false, preview: "New conversation", messages: [] };

test("a new SMS number supports messages and offline drafts without creating a lead, including after restore", () => {
  let state = seedState();
  const count = state.leads.length;
  assert.equal(smsRecipient(state, phone).lead, undefined);
  state = reducer(state, { type: "NEW_THREAD", thread });
  state = reducer(state, { type: "MESSAGE", id: thread.id, text: "Hello from the demo" });
  assert.equal(state.leads.length, count);
  assert.equal(visibleThreads(state).find(item => item.id === thread.id).messages[0].text, "Hello from the demo");
  state = reducer({ ...state, online: false }, { type: "MESSAGE", id: thread.id, text: "Offline message" });
  const restored = restoreState(JSON.parse(JSON.stringify(state)));
  assert.equal(smsRecipient(restored, "2025550199").thread.id, thread.id);
  assert.equal(restored.threads.find(item => item.id === thread.id).messages.at(-1).draft, true);
  assert.match(restored.queue.at(-1).label, /202/);
});

test("number threads reject invalid numbers and duplicates and stay private to their creator", () => {
  const initial = seedState();
  const state = reducer(initial, { type: "NEW_THREAD", thread });
  assert.equal(reducer(state, { type: "NEW_THREAD", thread: { ...thread, id: "duplicate", phone: "2025550199" } }), state);
  assert.equal(reducer(initial, { type: "NEW_THREAD", thread: { ...thread, phone: "123" } }), initial);
  const caller = { ...state, role: "caller" };
  assert(!visibleThreads(caller).some(item => item.id === thread.id));
  assert.equal(reducer(caller, { type: "MESSAGE", id: thread.id, text: "Must not edit another person's number thread" }), caller);
  const client = { ...state, role: "client" };
  assert(smsRecipient(client, phone).error);
  assert.equal(reducer(client, { type: "NEW_THREAD", thread }), client);
});

test("SMS number lookup reuses linked conversations and cannot bypass lead scope", () => {
  const state = seedState();
  const recipient = smsRecipient(state, "8135550101");
  assert.equal(recipient.lead.id, "l01");
  assert.equal(recipient.thread.channel, "SMS");
  assert.equal(reducer(state, { type: "NEW_THREAD", thread: { ...thread, phone: recipient.phone } }), state);
  const caller = { ...state, role: "caller" };
  const hidden = state.leads.find(lead => lead.assignee === "Alex Rivera");
  assert(smsRecipient(caller, hidden.phone).error);
});

test("hangup logs one call, outcome replaces its pending row, and manual-number calls survive clearing and restore", () => {
  let state = seedState();
  const unsubscribe = subscribeCallLog(call => { state = reducer(state, { type: "CALL_LOG", call }); });
  try {
    beginDemoCall(state.leads[0]);
    const id = getCallSession().callId;
    endDemoCall("contact");
    assert.equal(endDemoCall(), false);
    assert.equal(state.callLog.filter(call => call.id === id).length, 1);
    assert.equal(visibleCallLog(state).find(call => call.id === id).outcome, "Outcome not recorded");
    state = reducer(state, { type: "CALL", leadId: "l01", outcome: "Voicemail", session: getCallSession() });
    assert.equal(visibleCallLog(state).filter(call => call.id === id).length, 1);
    const logged = visibleCallLog(state).find(call => call.id === id);
    assert.equal(logged.outcome, "Voicemail");
    assert.equal(logged.endedBy, "contact");
    const changedPhone = { ...state, leads: state.leads.map(lead => lead.id === "l01" ? { ...lead, phone: "+1 (202) 555-0110" } : lead) };
    assert.equal(visibleCallLog(changedPhone).find(call => call.id === id).phone, logged.phone, "history keeps the number actually called when the lead's number changes");
    assert.match(callDuration(logged), /^\d+:\d{2}$/);
    clearCallOutcome();
    beginDemoCall({ id: "manual", phone, adHoc: true });
    endDemoCall();
    clearCallOutcome();
    const restored = restoreState(JSON.parse(JSON.stringify(state)));
    assert.equal(visibleCallLog(restored).find(call => !call.leadId).phone, phone);
    assert(!visibleCallLog({ ...restored, role: "caller" }).some(call => !call.leadId));
  } finally { unsubscribe(); clearCallOutcome(); }
});

test("quick call outcomes retain real timing without requiring a separate hangup", () => {
  const state = seedState();
  try {
    beginDemoCall(state.leads[0]);
    const updated = reducer(state, { type: "CALL", leadId: "l01", outcome: "Not available", session: getCallSession() });
    const call = updated.leads[0].calls.at(-1);
    assert.equal(call.id, getCallSession().callId);
    assert(call.endedAt >= call.startedAt);
    assert.equal(call.agent, ROLES[state.role].person);
    assert.equal(callDuration(state.leads[0].calls[0]), "", "legacy history must not invent a duration");
  } finally { clearCallOutcome(); }
});
