import { test } from "node:test";
import assert from "node:assert/strict";
import { AuthError, createAuth } from "../auth-client.js";

/** A fake auth service: answers by path, and records every request. */
function fakeService(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : undefined });
    const answer = typeof answers[path] === "function" ? answers[path](calls.at(-1)) : answers[path];
    if (answer instanceof Error) throw answer;
    const { status = 200, body = {} } = answer ?? { status: 404, body: { error: "Not found.", code: "not_found" } };
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

function memoryStorage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map };
}

const tokens = (access, refresh, expiresIn = 900) => ({ status: 200, body: { access_token: access, refresh_token: refresh, expires_in: expiresIn, token_type: "Bearer" } });

test("signing in keeps the access token in memory and the refresh token in storage", async () => {
  const storage = memoryStorage();
  const { calls, fetchImpl } = fakeService({ "/v1/sessions": tokens("A1", "R1") });
  const auth = createAuth({ base: "http://auth.example/", storage, fetchImpl });
  await auth.signIn("sami@example.com", "pw", undefined, "desktop");
  assert.deepEqual(calls[0].body, { email: "sami@example.com", password: "pw", kind: "desktop" });
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(await auth.accessToken(), "A1");
  assert.equal(storage.map.get("callerwhale.auth.refresh"), "R1");
  assert.equal(calls.length, 1, "a current token needs no request");
  assert.equal(auth.signedIn(), true);
});

test("a token about to expire is refreshed, once for many callers", async () => {
  let clock = 0;
  const storage = memoryStorage();
  let refreshes = 0;
  const { fetchImpl } = fakeService({
    "/v1/sessions": tokens("A1", "R1", 900),
    "/v1/sessions/refresh": call => {
      refreshes++;
      assert.equal(call.body.refresh_token, "R1");
      return tokens("A2", "R2", 900);
    },
  });
  const auth = createAuth({ base: "http://auth.example", storage, fetchImpl, now: () => clock });
  await auth.signIn("s@example.com", "pw");
  clock = 850_000; // less than a minute left
  const [a, b, c] = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
  assert.deepEqual([a, b, c], ["A2", "A2", "A2"]);
  assert.equal(refreshes, 1);
  assert.equal(storage.map.get("callerwhale.auth.refresh"), "R2");
});

test("after a reload the stored refresh token signs back in", async () => {
  const storage = memoryStorage();
  storage.setItem("callerwhale.auth.refresh", "R9");
  const { fetchImpl } = fakeService({ "/v1/sessions/refresh": tokens("A9", "R10") });
  const auth = createAuth({ base: "http://auth.example", storage, fetchImpl });
  assert.equal(auth.signedIn(), true);
  assert.equal(await auth.accessToken(), "A9");
});

test("a session that ended elsewhere signs this device out", async () => {
  const storage = memoryStorage();
  storage.setItem("callerwhale.auth.refresh", "R1");
  let changes = 0;
  const { fetchImpl } = fakeService({ "/v1/sessions/refresh": { status: 401, body: { error: "Sign in first.", code: "unauthenticated" } } });
  const auth = createAuth({ base: "http://auth.example", storage, fetchImpl, onChange: () => changes++ });
  await assert.rejects(auth.accessToken(), error => error instanceof AuthError && error.status === 401);
  assert.equal(auth.signedIn(), false);
  assert.equal(storage.map.has("callerwhale.auth.refresh"), false);
  assert.equal(changes, 1);
  assert.equal(await auth.accessToken(), null);
});

test("auth's refusals keep their code and sentence; an unreachable service says so", async () => {
  const { fetchImpl } = fakeService({
    "/v1/sessions": { status: 401, body: { error: "Enter the code from your authenticator app.", code: "mfa_required" } },
    "/v1/providers": new TypeError("network down"),
  });
  const auth = createAuth({ base: "http://auth.example", storage: memoryStorage(), fetchImpl });
  await assert.rejects(auth.signIn("s@example.com", "pw"), error => error.code === "mfa_required" && error.message.startsWith("Enter the code"));
  await assert.rejects(auth.providers(), error => error.code === "offline" && error.status === 0);
});

test("signing out forgets the tokens here and ends the session at auth", async () => {
  const storage = memoryStorage();
  const { calls, fetchImpl } = fakeService({ "/v1/sessions": tokens("A1", "R1"), "/v1/sessions/sign-out": { status: 200, body: { ok: true } } });
  const auth = createAuth({ base: "http://auth.example", storage, fetchImpl });
  await auth.signIn("s@example.com", "pw");
  await auth.signOut();
  assert.equal(calls.at(-1).path, "/v1/sessions/sign-out");
  assert.deepEqual(calls.at(-1).body, { refresh_token: "R1" });
  assert.equal(auth.signedIn(), false);
  assert.equal(await auth.accessToken(), null);
});

test("calls that need the person carry the bearer token; a step-up keeps the refresh token", async () => {
  const storage = memoryStorage();
  const { calls, fetchImpl } = fakeService({
    "/v1/oauth/exchange": tokens("A1", "R1"),
    "/v1/mfa/verify": { status: 200, body: { access_token: "A-mfa", expires_in: 900, token_type: "Bearer" } },
    "/v1/me": { status: 200, body: { id: "u" } },
  });
  const auth = createAuth({ base: "http://auth.example", storage, fetchImpl });
  await auth.exchange("one-time");
  await auth.verifyMfa("123456");
  assert.equal(calls[1].init.headers.Authorization, "Bearer A1");
  assert.equal(await auth.accessToken(), "A-mfa");
  assert.equal(storage.map.get("callerwhale.auth.refresh"), "R1");
  await auth.me();
  assert.equal(calls[2].init.headers.Authorization, "Bearer A-mfa");
});

test("provider sign-in addresses", () => {
  const auth = createAuth({ base: "https://auth.callerwhale.example/", storage: memoryStorage(), fetchImpl: async () => ({}) });
  assert.equal(auth.startUrl("google", "app"), "https://auth.callerwhale.example/v1/oauth/google/start?target=app");
  assert.equal(auth.startUrl("apple", "desktop", 48123), "https://auth.callerwhale.example/v1/oauth/apple/start?target=desktop&port=48123");
});

test("storage that refuses to work still signs in for the life of the page", async () => {
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
  const { fetchImpl } = fakeService({ "/v1/sessions": tokens("A1", "R1") });
  const auth = createAuth({ base: "http://auth.example", storage: broken, fetchImpl });
  await auth.signIn("s@example.com", "pw");
  assert.equal(await auth.accessToken(), "A1");
});

test("a forgotten password is reset with the emailed code", async () => {
  const { calls, fetchImpl } = fakeService({ "/v1/password/forgot": { body: { ok: true } }, "/v1/password/reset": { body: { ok: true } } });
  const auth = createAuth({ base: "http://auth.example", storage: memoryStorage(), fetchImpl });
  await auth.forgotPassword("sami@example.com");
  await auth.resetPassword("CODE", "a brand new password");
  assert.deepEqual(calls[0].body, { email: "sami@example.com" });
  assert.deepEqual(calls[1].body, { token: "CODE", new: "a brand new password" });
});

test("coming back from a provider with an error says why, and with a code signs in", async () => {
  const location = { search: "?oauth_error=Sign-in+was+cancelled.", pathname: "/signin", hash: "" };
  const history = { replaceState: () => {} };
  const was = { location: globalThis.location, history: globalThis.history };
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  Object.defineProperty(globalThis, "history", { value: history, configurable: true });
  try {
    const { fetchImpl } = fakeService({ "/v1/oauth/exchange": tokens("A1", "R1") });
    const auth = createAuth({ base: "http://auth.example", storage: memoryStorage(), fetchImpl });
    await assert.rejects(auth.finishProvider(), error => error instanceof AuthError && error.code === "oauth_error" && /cancelled/.test(error.message));
    location.search = "?callerwhale_code=ONE";
    assert.equal(await auth.finishProvider(), true);
    assert.equal(await auth.accessToken(), "A1");
    location.search = "";
    assert.equal(await auth.finishProvider(), false);
  } finally {
    Object.defineProperty(globalThis, "location", { value: was.location, configurable: true });
    Object.defineProperty(globalThis, "history", { value: was.history, configurable: true });
  }
});

test("a sign-in that needs a second step hands over the challenge and its methods, and answering keeps the tokens", async () => {
  const storage = memoryStorage();
  const { calls, fetchImpl } = fakeService({
    "/v1/sessions": { status: 401, body: { error: "Confirm it is you with a second step.", code: "mfa_required", challenge: "CH1", methods: ["totp", "email", "push"] } },
    "/v1/mfa/challenge/send": { body: { sent: true } },
    "/v1/mfa/challenge/answer": tokens("A2", "R2"),
    "/v1/mfa/challenge/status": { body: { push: "pending" } },
  });
  const auth = createAuth({ base: "http://auth.example", storage, fetchImpl });
  const error = await auth.signIn("sami@example.com", "pw").catch(reason => reason);
  assert.equal(error.code, "mfa_required");
  assert.deepEqual(error.data, { error: "Confirm it is you with a second step.", code: "mfa_required", challenge: "CH1", methods: ["totp", "email", "push"] });
  assert.equal(storage.map.get("callerwhale.auth.refresh"), undefined, "nothing is kept before the second step");

  await auth.sendCode("CH1", "email");
  await auth.sendCode("CH1", "push", "Chrome on Windows");
  assert.deepEqual(calls[1].body, { challenge: "CH1", method: "email" });
  assert.deepEqual(calls[2].body, { challenge: "CH1", method: "push", device: "Chrome on Windows" });
  assert.equal(await auth.approvalState("CH1"), "pending");
  await auth.answer("CH1", "email", "123456");
  assert.deepEqual(calls[4].body, { challenge: "CH1", method: "email", code: "123456" });
  assert.equal(await auth.accessToken(), "A2");
  assert.equal(storage.map.get("callerwhale.auth.refresh"), "R2");
});

test("the security calls use the signed-in token, the right verbs and the labels given", async () => {
  const { calls, fetchImpl } = fakeService({
    "/v1/sessions": tokens("A1", "R1"),
    "/v1/mfa/factors": { body: { factors: [], max_totp: 3 } },
    "/v1/mfa/factors/f%201": { body: { ok: true } },
    "/v1/mfa/totp/confirm": { body: { removed: ["Phone 1"], recovery_codes: [] } },
    "/v1/sessions/refresh": tokens("A1b", "R1b"),
    "/v1/mfa/approvals": { body: { approvals: [{ id: "x" }] } },
    "/v1/mfa/approvals/x": { body: { ok: true } },
    "/v1/mfa/challenge/start": { body: { challenge: "C", methods: ["email"] } },
    "/v1/mfa/telegram/link": { body: { url: "https://t.me/bot?start=c" } },
  });
  const auth = createAuth({ base: "http://auth.example", storage: memoryStorage(), fetchImpl });
  await auth.signIn("s@example.com", "pw");
  await auth.factors();
  await auth.removeFactor("f 1");
  assert.equal(calls.at(-1).init.method, "DELETE");
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer A1");
  assert.deepEqual((await auth.confirmMfa("123456", "Phone 4")).removed, ["Phone 1"]);
  assert.deepEqual(calls.find(c => c.path === "/v1/mfa/totp/confirm").body, { code: "123456", label: "Phone 4" });
  assert.deepEqual(await auth.approvals(), [{ id: "x" }]);
  await auth.decide("x", false);
  assert.deepEqual(calls.at(-1).body, { approve: false });
  assert.deepEqual(await auth.startStepUp(), { challenge: "C", methods: ["email"] });
  assert.equal((await auth.linkTelegram()).url, "https://t.me/bot?start=c");
});


test("human proofs are sent only to auth, including protected social starts", async () => {
  const { calls, fetchImpl } = fakeService({
    "/v1/accounts": tokens("A", "R"),
    "/v1/sessions": tokens("A", "R"),
    "/v1/security": { body: { bot_protection: { enabled: true, site_key: "public" } } },
    "/v1/oauth/google/start": { body: { url: "https://accounts.google.com/authorize" } },
  });
  const auth = createAuth({ base: "https://auth.example", storage: memoryStorage(), fetchImpl });
  await auth.signUp("Sami", "s@example.com", "Aa1!aaaa", "browser", "signup-proof");
  await auth.signIn("s@example.com", "Aa1!aaaa", undefined, "desktop", "signin-proof");
  assert.equal(calls[0].body.human_token, "signup-proof");
  assert.equal(calls[1].body.human_token, "signin-proof");
  assert.equal((await auth.security()).bot_protection.site_key, "public");
  assert.equal(await auth.providerUrl("google", "desktop", 48123, "social-proof"), "https://accounts.google.com/authorize");
  assert.deepEqual(calls.at(-1).body, { target: "desktop", port: 48123, human_token: "social-proof", action: "signin" });
  assert.equal(calls.at(-1).init.method, "POST");
});
