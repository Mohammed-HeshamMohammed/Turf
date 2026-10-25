import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { addTranscriptLine, beginDemoCall, clearCallOutcome, endDemoCall, getCallSession, setCallSession } from "../src/callSession.js";

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
