import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createCalling } from "../src/calling.ts";
import { beginDemoCall, clearCallOutcome, getCallSession } from "../src/callSession.ts";

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

test("a listed team phone gets a real call that the page logs itself", async () => {
  const events = {};
  const real = {
    allowed: phone => phone === "+201001234567",
    start: async (_lead, handlers) => Object.assign(events, handlers),
    hangup: () => {
      events.hungUp = true;
    },
  };
  const { dialer, log } = fakeDialer();
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real });
  const teamPhone = { id: "lead-9", name: "Team phone", phone: "+201001234567" };
  assert.deepEqual(await calling.start(signedIn, teamPhone), { ok: true, mode: "real" });
  assert.equal(getCallSession().answeredAt, null, "ringing");
  events.onAnswered();
  assert.ok(getCallSession().answeredAt);
  events.onEnded("contact");
  assert.equal(getCallSession().endedBy, "contact");
  assert.deepEqual(await calling.wrapUp({ outcome: "Not interested" }), { logHere: true });
  assert.deepEqual(log.placed, [], "the dialer never sees a real call");
});

const teamPhone = { id: "lead-9", name: "Team phone", phone: "+201001234567" };

test("the sample workspace never makes a real call, even to a listed team phone", () => {
  const real = { allowed: () => true, start: async () => {}, hangup: () => {} };
  const calling = createCalling({ dialer: fakeDialer().dialer, hasDialer: () => true, every: manualClock().every, real });
  assert.equal(calling.modeFor(sample, teamPhone), "demo");
  assert.equal(calling.modeFor(signedIn, teamPhone), "real");
});

test("a hangup the dialer refuses keeps the call on screen and followed, and says why", async () => {
  const { dialer } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  dialer.hangup = async () => {
    throw Object.assign(new Error("The carrier did not end the call. Try again in a moment."), { status: 502 });
  };
  const clock = manualClock();
  const calling = createCalling({ dialer, hasDialer: () => true, every: clock.every, real: noReal });
  await calling.start(signedIn, lead);
  assert.deepEqual(await calling.end(), { ok: false, error: "The carrier did not end the call. Try again in a moment." });
  assert.equal(getCallSession().active, true);
  assert.equal(clock.running(), true, "a hangup from the lead's side is still seen");
  dialer.hangup = async () => ({});
  assert.deepEqual(await calling.end(), { ok: true });
  assert.equal(getCallSession().awaitingOutcome, true);
});

test("the call rings on screen while the dialer places it, and ending it then hangs it up once placed", async () => {
  const { dialer, log } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  let placed = () => {};
  dialer.place = leadId => {
    log.placed.push(leadId);
    return new Promise(resolve => {
      placed = () => resolve({ id: "call-1" });
    });
  };
  const clock = manualClock();
  const calling = createCalling({ dialer, hasDialer: () => true, every: clock.every, real: noReal });
  const starting = calling.start(signedIn, lead);
  assert.equal(getCallSession().active, true, "on screen at once");
  assert.equal(getCallSession().mode, "dialer");
  assert.equal(beginDemoCall({ id: "lead-2", name: "Someone else", phone: "+1 (813) 555-0002" }), false, "nothing else starts meanwhile");
  const ending = calling.end();
  placed();
  assert.deepEqual(await starting, { ok: true, mode: "dialer" });
  assert.deepEqual(await ending, { ok: true });
  assert.deepEqual(log.hungUp, ["call-1"]);
  assert.equal(getCallSession().awaitingOutcome, true);
  assert.equal(getCallSession().serverCallId, "call-1", "its outcome still goes to the dialer");
  assert.equal(clock.running(), false);
});

test("ending a real call while it is still connecting hangs it up once it exists", async () => {
  const steps = [];
  let connected = () => {};
  const real = {
    allowed: () => true,
    start: () =>
      new Promise(resolve => {
        connected = () => {
          steps.push("called");
          resolve();
        };
      }),
    hangup: () => steps.push("hung up"),
  };
  const calling = createCalling({ dialer: fakeDialer().dialer, hasDialer: () => true, every: manualClock().every, real });
  const starting = calling.start(signedIn, teamPhone);
  const ending = calling.end();
  connected();
  await starting;
  await ending;
  assert.deepEqual(steps, ["called", "hung up"]);
  assert.equal(getCallSession().awaitingOutcome, true);
});

test("a dialer that stops answering shows on the call, and the message goes once it answers again", async () => {
  const { dialer } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  const clock = manualClock();
  const calling = createCalling({ dialer, hasDialer: () => true, every: clock.every, real: noReal });
  await calling.start(signedIn, lead);
  const answering = dialer.get;
  dialer.get = async () => {
    throw new Error("The server cannot be reached");
  };
  await clock.run();
  await clock.run();
  assert.equal(getCallSession().trouble, "", "a missed answer or two is normal");
  await clock.run();
  assert.match(getCallSession().trouble, /not answering/);
  dialer.get = answering;
  await clock.run();
  assert.equal(getCallSession().trouble, "");
});

test("an outcome the dialer had already logged differently says so instead of claiming it was saved", async () => {
  const { dialer } = fakeDialer([{ id: "call-1", answered_at: null, ended_at: null, hangup_source: "" }]);
  dialer.wrapUp = async () => {
    throw Object.assign(new Error("This call is already logged."), { status: 409 });
  };
  const calling = createCalling({ dialer, hasDialer: () => true, every: manualClock().every, real: noReal });
  await calling.start(signedIn, lead);
  await calling.end();
  dialer.get = async () => ({ id: "call-1", outcome: "Reached" });
  assert.deepEqual(await calling.wrapUp({ outcome: "Not interested" }), {
    logHere: false,
    notice: "The dialer had already logged this call as Reached, so Not interested was not saved.",
  });
  dialer.get = async () => ({ id: "call-1", outcome: "Not interested" });
  assert.deepEqual(await calling.wrapUp({ outcome: "Not interested" }), { logHere: false });
});
