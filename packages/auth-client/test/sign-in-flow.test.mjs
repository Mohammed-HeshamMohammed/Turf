import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError } from "../auth-client.js";
import { createSignInFlow, needsCode } from "../sign-in-flow.js";

function memoryStorage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map };
}

/** A fake auth client: records calls; `second` makes the password step ask for a second step with those methods. */
function fakeAuth({ second = null, answer = () => {}, approval = [] } = {}) {
  const calls = [];
  return {
    calls,
    signIn: async (...args) => {
      calls.push(["signIn", ...args]);
      if (second) throw new AuthError(401, "mfa_required", "Confirm it is you.", { challenge: "CH", methods: second });
    },
    sendCode: async (...args) => calls.push(["sendCode", ...args]),
    answer: async (...args) => {
      calls.push(["answer", ...args]);
      answer(...args);
    },
    approvalState: async () => approval.shift() ?? "pending",
  };
}

test("a password with no second step signs in at once, with the human check's token and the device kind", async () => {
  const auth = fakeAuth();
  let done = 0;
  const flow = createSignInFlow({ auth, humanToken: async () => "HT", onSignedIn: () => done++, storage: memoryStorage() });
  await flow.signIn(" sami@example.com ", "pw", { kind: "shared" });
  assert.deepEqual(auth.calls[0], ["signIn", "sami@example.com", "pw", undefined, "shared", "HT"]);
  assert.equal(done, 1);
  assert.equal(flow.getState().step, "password");
});

test("an authenticator is the first way offered, and its code finishes the sign-in", async () => {
  const auth = fakeAuth({ second: ["email", "totp"] });
  let done = 0;
  const storage = memoryStorage();
  const flow = createSignInFlow({ auth, onSignedIn: () => done++, storage });
  await flow.signIn("s@example.com", "pw");
  assert.equal(flow.getState().step, "second");
  assert.equal(flow.getState().method, "totp");
  assert.equal(needsCode(flow.getState()), true);
  assert.equal(auth.calls.some(c => c[0] === "sendCode"), false, "nothing is sent for an authenticator");
  await flow.answer(" 123456 ");
  assert.deepEqual(auth.calls.at(-1), ["answer", "CH", "totp", "123456"]);
  assert.equal(done, 1);
  assert.equal(storage.map.size, 0, "nothing is left kept");
});

test("an emailed code is sent at once, and another way can be chosen", async () => {
  const auth = fakeAuth({ second: ["email", "telegram"] });
  const flow = createSignInFlow({ auth, storage: memoryStorage() });
  await flow.signIn("s@example.com", "pw");
  assert.deepEqual(auth.calls[1], ["sendCode", "CH", "email", undefined]);
  assert.equal(flow.getState().sent, true);
  flow.choose("telegram");
  assert.equal(flow.getState().sent, false);
  assert.equal(needsCode(flow.getState()), false);
  await flow.send();
  assert.deepEqual(auth.calls.at(-1), ["sendCode", "CH", "telegram", undefined]);
  flow.choose("totp"); // not offered
  assert.equal(flow.getState().method, "telegram");
});

test("a refresh comes back to the step; an old one does not", async () => {
  const storage = memoryStorage();
  let clock = 0;
  const first = createSignInFlow({ auth: fakeAuth({ second: ["totp"] }), storage, now: () => clock });
  await first.signIn("s@example.com", "pw");
  const again = createSignInFlow({ auth: fakeAuth(), storage, now: () => clock });
  assert.equal(again.restore(), true);
  assert.equal(again.getState().challenge, "CH");
  assert.equal(again.getState().method, "totp");
  clock = 10 * 60_000;
  const late = createSignInFlow({ auth: fakeAuth(), storage, now: () => clock });
  assert.equal(late.restore(), false);
  assert.equal(storage.map.size, 0);
});

test("a step auth no longer knows goes back to the password and says why", async () => {
  const storage = memoryStorage();
  const auth = fakeAuth({ second: ["totp"], answer: () => { throw new AuthError(403, "forbidden", "This sign-in has expired. Start again."); } });
  const flow = createSignInFlow({ auth, storage });
  await flow.signIn("s@example.com", "pw");
  await flow.answer("123456");
  assert.equal(flow.getState().step, "password");
  assert.equal(flow.getState().error, "This sign-in has expired. Start again.");
  assert.equal(storage.map.size, 0);
});

test("a wrong code stays on the step with the message", async () => {
  const auth = fakeAuth({ second: ["totp"], answer: () => { throw new AuthError(401, "wrong_code", "That code is not right."); } });
  const flow = createSignInFlow({ auth, storage: memoryStorage() });
  await flow.signIn("s@example.com", "pw");
  await flow.answer("000000");
  assert.equal(flow.getState().step, "second");
  assert.equal(flow.getState().error, "That code is not right.");
  assert.equal(flow.getState().busy, false);
});

test("an approval on another device is asked for, watched, and finishes the sign-in", async () => {
  const auth = fakeAuth({ second: ["push"], approval: ["pending", "approved"] });
  let done = 0;
  const flow = createSignInFlow({ auth, device: "Caller Whale desktop app", onSignedIn: () => done++, storage: memoryStorage(), pollMs: 5 });
  await flow.signIn("s@example.com", "pw");
  assert.equal(flow.getState().method, "push");
  assert.equal(auth.calls.some(c => c[0] === "sendCode"), false, "an approval is asked for by the person");
  await flow.send();
  assert.deepEqual(auth.calls.at(-1), ["sendCode", "CH", "push", "Caller Whale desktop app"]);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(auth.calls.at(-1), ["answer", "CH", "push"]);
  assert.equal(done, 1);
});

test("going back clears the step", async () => {
  const storage = memoryStorage();
  const flow = createSignInFlow({ auth: fakeAuth({ second: ["totp"] }), storage });
  await flow.signIn("s@example.com", "pw");
  flow.back();
  assert.equal(flow.getState().step, "password");
  assert.equal(storage.map.size, 0);
});

test("a second step that started elsewhere is confirmed the same way", async () => {
  const auth = fakeAuth();
  let done = 0;
  const flow = createSignInFlow({ auth, onSignedIn: () => done++, storage: memoryStorage() });
  flow.begin({ challenge: "UP", methods: ["push", "email"] });
  assert.equal(flow.getState().step, "second");
  assert.equal(flow.getState().method, "email");
  await flow.send();
  await flow.answer("111111");
  assert.deepEqual(auth.calls.at(-1), ["answer", "UP", "email", "111111"]);
  assert.equal(done, 1);
});
