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

test("group chats are for their members, and carry GIFs, polls, replies and reactions", () => {
  let state = { ...seedState(), role: "manager" };
  const me = ROLES.manager.person;
  const group = { id: "g1", channel: "Group", title: "Tampa closers", members: ["Alex Rivera"], preview: "New group", unread: false, messages: [] };
  assert.equal(reducer(state, { type: "NEW_THREAD", thread: { ...group, members: [] } }), state, "a group needs another member");
  state = reducer(state, { type: "NEW_THREAD", thread: group });
  assert.deepEqual(visibleThreads(state).find(item => item.id === "g1").members, [me, "Alex Rivera"]);
  // Someone outside the group never sees it.
  const outsider = Object.keys(ROLES).find(role => role !== "client" && ![me, "Alex Rivera"].includes(ROLES[role].person));
  assert.equal(visibleThreads({ ...state, role: outsider }).some(item => item.id === "g1"), false);

  state = reducer(state, { type: "MESSAGE", id: "g1", attach: { kind: "gif", gif: { url: "https://media2.giphy.com/media/abc/200.gif", title: "Deal closed" } } });
  assert.equal(reducer(state, { type: "MESSAGE", id: "g1", attach: { kind: "gif", gif: { url: "https://evil.example/x.gif" } } }), state, "GIFs only come from GIPHY");
  state = reducer(state, { type: "MESSAGE", id: "g1", attach: { kind: "poll", poll: { question: "Call time?", options: ["10 am", "2 pm", "2 pm"] } } });
  let messages = visibleThreads(state).find(item => item.id === "g1").messages;
  assert.equal(messages[0].kind, "gif");
  assert.deepEqual(messages[1].poll.options.map(option => option.text), ["10 am", "2 pm"]);
  assert.equal(visibleThreads(state).find(item => item.id === "g1").preview, "Poll: Call time?");

  state = reducer(state, { type: "VOTE", id: "g1", index: 1, option: 0 });
  state = reducer(state, { type: "VOTE", id: "g1", index: 1, option: 1 });
  messages = visibleThreads(state).find(item => item.id === "g1").messages;
  assert.deepEqual(messages[1].poll.options.map(option => option.votes), [[], [me]], "voting again moves the vote");

  state = reducer(state, { type: "REACT", id: "g1", index: 0, emoji: "🎉" });
  assert.deepEqual(visibleThreads(state).find(item => item.id === "g1").messages[0].reactions, { "🎉": [me] });
  state = reducer(state, { type: "REACT", id: "g1", index: 0, emoji: "🎉" });
  assert.equal(visibleThreads(state).find(item => item.id === "g1").messages[0].reactions["🎉"], undefined, "a second tap takes it back");

  state = reducer(state, { type: "MESSAGE", id: "g1", text: "Agreed", replyTo: 1 });
  assert.equal(visibleThreads(state).find(item => item.id === "g1").messages[2].replyTo, 1);
  // Polls are for team and group chats only.
  const sms = visibleThreads(state).find(item => item.channel === "SMS" && item.leadId);
  assert.equal(reducer(state, { type: "MESSAGE", id: sms.id, attach: { kind: "poll", poll: { question: "?", options: ["a", "b"] } } }), state);
});

test("archiving moves a conversation aside and back, only for people who can see it", () => {
  let state = seedState();
  const id = visibleThreads(state)[0].id;
  state = reducer(state, { type: "ARCHIVE", id, archived: true });
  assert.equal(visibleThreads(state).find(item => item.id === id).archived, true);
  state = reducer(state, { type: "ARCHIVE", id, archived: false });
  assert.equal(visibleThreads(state).find(item => item.id === id).archived, false);
  const client = { ...seedState(), role: "client" };
  const hidden = client.threads.find(item => !visibleThreads(client).some(seen => seen.id === item.id));
  assert.equal(reducer(client, { type: "ARCHIVE", id: hidden.id, archived: true }), client);
});

test("an email reply keeps its To, Cc and Subject, and a bad address is refused", () => {
  let state = seedState();
  const email = visibleThreads(state).find(item => item.channel === "Email");
  const fields = { to: "patricia.flores@example.com", cc: "alex.rivera@oakpalm.example; ", subject: "Re: Your property on Baywood Drive" };
  state = reducer(state, { type: "MESSAGE", id: email.id, text: "Early November works for us.", email: fields });
  assert.deepEqual(visibleThreads(state).find(item => item.id === email.id).messages.at(-1).email, { to: ["patricia.flores@example.com"], cc: ["alex.rivera@oakpalm.example"], subject: "Re: Your property on Baywood Drive" });
  assert.equal(reducer(state, { type: "MESSAGE", id: email.id, text: "Hi", email: { ...fields, to: "not an address" } }), state);
});
