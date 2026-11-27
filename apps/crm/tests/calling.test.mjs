import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createCalling } from "../src/calling.ts";
import { clearCallOutcome, getCallSession } from "../src/callSession.ts";

const lead = { id: "lead-1", name: "Sarah Johnson", phone: "+1 (813) 555-0001" };
const signedIn = { remote: { id: "org-1" } };
const sample = { remote: null };

function fakeDialer(states = []) {
  const log = { placed: [], hungUp: [], wrapped: [] };
  let n = 0;
  const dialer = {
    place: async leadId => {
      log.placed.push(leadId);
      return { id: "call-1" };
    },
    get: async () => states[Math.min(n++, states.length - 1)],
    hangup: async id => {
      log.hungUp.push(id);
      return {};
    },
    wrapUp: async (id, body) => {
      log.wrapped.push({ id, ...body });
      return {};
    },
  };
  return { dialer, log };
}

// A clock the test advances by hand: `run()` is one poll.
function manualClock() {
  let tick = null;
  return {
    every: (_ms, fn) => {
      tick = fn;
      return () => {
        tick = null;
      };
    },
    run: async () => {
      if (tick) await tick();
    },
    running: () => tick !== null,
  };
}

const noReal = { allowed: () => false, start: async () => {}, hangup: () => {} };

afterEach(clearCallOutcome);

test("a signed-in workspace places the call on the dialer and follows it until the lead hangs up", async () => {
  const { dialer, log } = fakeDialer([
    { id: "call-1", answered_at: null, ended_at: null, hangup_source: "" },
    { id: "call-1", answered_at: "2026-11-27T15:00:04Z", ended_at: null, hangup_source: "" },
    { id: "call-1", answered_at: "2026-11-27T15:00:04Z", ended_at: "2026-11-27T15:00:49Z", hangup_source: "callee" },
  ]);
  const clock = manualClock();
  const calling = createCalling({ dialer, hasDialer: () => true, every: clock.every, real: noReal });
  assert.deepEqual(await calling.start(signedIn, lead), { ok: true, mode: "dialer" });
  assert.deepEqual(log.placed, ["lead-1"]);
  assert.equal(getCallSession().serverCallId, "call-1");
  await clock.run();
  assert.equal(getCallSession().answeredAt, null, "still ringing");
  await clock.run();
  assert.equal(getCallSession().answeredAt, Date.parse("2026-11-27T15:00:04Z"));
  await clock.run();
  assert.equal(getCallSession().awaitingOutcome, true);
  assert.equal(getCallSession().endedBy, "contact");
  assert.equal(clock.running(), false, "polling stops when the call ends");
});

test("hanging up tells the dialer, and the outcome goes to the dialer instead of being logged twice", async () => {
  const { dialer, log } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  const clock = manualClock();
  const calling = createCalling({ dialer, hasDialer: () => true, every: clock.every, real: noReal });
  await calling.start(signedIn, lead);
  await calling.end();
  assert.deepEqual(log.hungUp, ["call-1"]);
  assert.equal(getCallSession().endedBy, "agent");
  assert.equal(clock.running(), false);
  const saved = await calling.wrapUp({ outcome: "Callback", callbackAt: "2026-11-28T15:00", notes: "After work" });
  assert.deepEqual(saved, { logHere: false });
  assert.deepEqual(log.wrapped, [{ id: "call-1", outcome: "Callback", callbackAt: "2026-11-28T15:00", notes: "After work" }]);
});

test("an outcome for a call the dialer already settled is not an error", async () => {
  const { dialer } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  dialer.wrapUp = async () => {
    throw Object.assign(new Error("This call is already logged."), { status: 409 });
  };
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: noReal });
  await calling.start(signedIn, lead);
  await calling.end();
  assert.deepEqual(await calling.wrapUp({ outcome: "Not available" }), { logHere: false });
});

test("a refused outcome is reported so the caller can try again", async () => {
  const { dialer } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  dialer.wrapUp = async () => {
    throw Object.assign(new Error("The server cannot be reached"), { status: 0 });
  };
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: noReal });
  await calling.start(signedIn, lead);
  await calling.end();
  assert.deepEqual(await calling.wrapUp({ outcome: "Not interested" }), { logHere: false, error: "The server cannot be reached" });
});

test("a refused call leaves no call on screen", async () => {
  const { dialer } = fakeDialer();
  dialer.place = async () => {
    throw Object.assign(new Error("Leads are called and texted only between 08:00 and 21:00 their time."), { status: 409 });
  };
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: noReal });
  const started = await calling.start(signedIn, lead);
  assert.equal(started.ok, false);
  assert.match(started.error, /08:00/);
  assert.equal(getCallSession().active, false);
  assert.equal(getCallSession().awaitingOutcome, false);
});

test("a refused real call is taken off the screen, and a pending outcome from an earlier call is never cleared", async () => {
  const { dialer } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  const failingReal = {
    allowed: phone => phone === "+201001234567",
    start: async () => {
      throw new Error("Telnyx refused the login. Mint a new token.");
    },
    hangup: () => {},
  };
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: failingReal });
  const teamPhone = { id: "lead-9", name: "Team phone", phone: "+201001234567" };
  const refused = await calling.start(signedIn, teamPhone);
  assert.equal(refused.ok, false);
  assert.equal(getCallSession().active, false);
  assert.equal(getCallSession().awaitingOutcome, false, "nothing left on screen");
  // An earlier dialer call is waiting for its outcome; a refused second start must not touch it.
  await calling.start(signedIn, lead);
  await calling.end();
  assert.equal((await calling.start(signedIn, teamPhone)).ok, false);
  assert.equal(getCallSession().awaitingOutcome, true);
  assert.equal(getCallSession().serverCallId, "call-1");
});

test("the sample workspace, builds without a dialer and dial-pad numbers stay demo calls the page logs itself", async () => {
  const { dialer, log } = fakeDialer();
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: noReal });
  assert.deepEqual(await calling.start(sample, lead), { ok: true, mode: "demo" });
  assert.deepEqual(await calling.wrapUp({ outcome: "Voicemail" }), { logHere: true });
  clearCallOutcome();
  assert.equal(calling.modeFor(signedIn, { ...lead, adHoc: true }), "demo");
  const noDialer = createCalling({ dialer, hasDialer: () => false, every: manualClock().every, real: noReal });
  assert.equal(noDialer.modeFor(signedIn, lead), "demo");
  assert.deepEqual(log.placed, []);
});

test("a second click while the first call is being placed does not place two calls", async () => {
  const { dialer, log } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: noReal });
  const [first, second] = await Promise.all([calling.start(signedIn, lead), calling.start(signedIn, lead)]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.deepEqual(log.placed, ["lead-1"]);
});
