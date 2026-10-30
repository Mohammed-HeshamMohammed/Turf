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
