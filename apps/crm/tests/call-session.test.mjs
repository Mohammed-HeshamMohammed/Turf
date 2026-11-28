import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addTranscriptLine, beginDemoCall, beginServerCall, canBeginCall, clearCallOutcome, endDemoCall, getCallSession, markAnswered, setCallSession, subscribeCallLog } from "../src/callSession.ts";

const sarah = { id: "sarah", name: "Sarah Johnson", phone: "+1 (813) 555-0101" };
const michael = { id: "michael", name: "Michael Bennett", phone: "+1 (813) 555-0102" };
afterEach(clearCallOutcome);

test("contact hangup retains the lead and transcript and blocks the next call until feedback is saved", () => {
  assert.equal(beginDemoCall(sarah), true);
  const startedAt = getCallSession().startedAt;
  addTranscriptLine({ who: "Sarah", side: "owner", text: "Please call me next week." });
  assert.equal(beginDemoCall(michael), false, "an active call cannot be replaced");
  assert.equal(endDemoCall("contact"), true);
  const ended = getCallSession();
  assert.equal(ended.active, false);
  assert.equal(ended.awaitingOutcome, true);
  assert.equal(ended.endedBy, "contact");
  assert.equal(ended.lead.id, sarah.id);
  assert.equal(ended.startedAt, startedAt);
  assert(ended.endedAt >= startedAt);
  assert.equal(ended.transcript.at(-1).text, "Please call me next week.");
  assert.equal(beginDemoCall(michael), false, "auto dial must wait for feedback after a remote hangup");
  setCallSession({ captions: true });
  assert.equal(getCallSession().lead.id, sarah.id, "other controls cannot lose the pending lead");
  assert.equal(getCallSession().awaitingOutcome, true);
  assert.equal(endDemoCall(), false, "a late hangup cannot overwrite the end reason or time");
  assert.equal(getCallSession().endedBy, "contact");
  assert.equal(getCallSession().endedAt, ended.endedAt);
  clearCallOutcome();
  assert.equal(beginDemoCall(michael), true);
  assert.equal(getCallSession().awaitingOutcome, false);
  assert.equal(getCallSession().endedAt, null);
  assert.deepEqual(getCallSession().transcript, []);
});

test("agent hangup keeps the same feedback gate until the outcome is cleared", () => {
  beginDemoCall(sarah);
  endDemoCall();
  assert.equal(getCallSession().endedBy, "agent");
  assert.equal(getCallSession().lead.id, sarah.id);
  assert.equal(beginDemoCall(sarah), false, "redialing the same person also requires the previous outcome");
  assert.equal(beginDemoCall(michael), false);
  clearCallOutcome();
  assert.equal(getCallSession().lead, null);
  assert.equal(getCallSession().startedAt, null);
  assert.equal(getCallSession().awaitingOutcome, false);
});

test("manual dial-pad calls share the call gate and retain their unlinked number", () => {
  const manual = { id: "manual", name: "Dialed number", phone: "+44 20 7946 0123", adHoc: true };
  assert.equal(beginDemoCall(manual), true);
  assert.equal(getCallSession().lead.phone, manual.phone);
  assert.equal(getCallSession().lead.adHoc, true);
  assert.equal(beginDemoCall(sarah), false);
  endDemoCall();
  assert.equal(beginDemoCall(sarah), false, "the manual call must finish before a lead call starts");
  clearCallOutcome();
  assert.equal(beginDemoCall(sarah), true);
  assert.equal(getCallSession().lead.adHoc, false);
});

test("a dialer call shares the call gate, keeps the dialer's id, and rings until it is answered", () => {
  assert.equal(canBeginCall(sarah), true);
  assert.equal(beginServerCall(sarah, "call-1", "dialer"), true);
  assert.equal(getCallSession().mode, "dialer");
  assert.equal(getCallSession().serverCallId, "call-1");
  assert.equal(getCallSession().answeredAt, null, "ringing");
  assert.equal(canBeginCall(michael), false, "one call at a time");
  assert.equal(beginServerCall(michael, "call-2", "dialer"), false);
  markAnswered(1234);
  assert.equal(getCallSession().answeredAt, 1234);
  markAnswered(9999);
  assert.equal(getCallSession().answeredAt, 1234, "the first answer time stays");
  endDemoCall("contact");
  assert.equal(getCallSession().serverCallId, "call-1", "the id stays until the outcome is saved");
  clearCallOutcome();
  assert.equal(getCallSession().serverCallId, null);
  assert.equal(getCallSession().mode, "demo");
  assert.equal(getCallSession().answeredAt, null);
});

test("a demo call is answered as soon as it starts", () => {
  beginDemoCall(sarah);
  assert.equal(getCallSession().mode, "demo");
  assert.equal(getCallSession().answeredAt, getCallSession().startedAt);
});

test("no call starts without a phone number", () => {
  assert.equal(canBeginCall({ id: "x", name: "No phone", phone: " " }), false);
});

test("a dialer call adds nothing to the page's own call log, because the dialer records it", () => {
  const seen = [];
  const stop = subscribeCallLog(call => seen.push(call));
  beginServerCall(sarah, "call-1", "dialer");
  endDemoCall("agent");
  assert.deepEqual(seen, []);
  clearCallOutcome();
  beginServerCall(sarah, null, "real");
  endDemoCall("agent");
  assert.equal(seen.length, 1, "a real call is the page's to log");
  stop();
});
