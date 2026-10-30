import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirebaseAuth } from "../firebase-auth-client.js";

function memoryStorage() {
  const map = new Map();
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k), map };
}

const fail = code => Object.assign(new Error(code), { code });

/**
 * A fake Firebase: one account (ann@example.com / "right password"), with an authenticator when `totp` is set. The
 * code "123456" is right. Records what was called.
 */
function fakeFirebase({ totp = false, redirect = null } = {}) {
  const calls = [];
  let enrolled = totp ? [{ uid: "f1", factorId: "totp" }] : [];
  let secondFactor = null;
  const user = {
    uid: "fbAnn",
    email: "ann@example.com",
    displayName: "Ann",
    emailVerified: true,
    getIdToken: async force => (calls.push(["getIdToken", Boolean(force)]), secondFactor ? "ID-TOTP" : "ID"),
    getIdTokenResult: async () => ({ claims: { firebase: secondFactor ? { sign_in_second_factor: secondFactor } : {} } }),
    reload: async () => calls.push(["reload"]),
  };
  const auth = { currentUser: null, authStateReady: async () => undefined };
  const resolver = {
    hints: enrolled,
    resolveSignIn: async assertion => {
      if (assertion.code !== "123456") throw fail("auth/invalid-verification-code");
      secondFactor = "totp";
      auth.currentUser = user;
      return { user };
    },
  };
  const sdk = {
    auth,
    TotpMultiFactorGenerator: {
      FACTOR_ID: "totp",
      assertionForSignIn: (uid, code) => ({ uid, code }),
      assertionForEnrollment: (secret, code) => ({ secret, code }),
      generateSecret: async () => ({ secretKey: "SECRETKEY", generateQrCodeUrl: (email, issuer) => `otpauth://totp/${issuer}:${email}` }),
    },
    GoogleAuthProvider: class {
      id = "google.com";
      static credential = idToken => ({ providerId: "google.com", idToken });
    },
    signInWithCredential: async (_, credential) => {
      calls.push(["credential", credential.idToken]);
      if (totp) throw fail("auth/multi-factor-auth-required");
      auth.currentUser = user;
      return { user };
    },
    OAuthProvider: class {
      constructor(id) {
        this.id = id;
      }
    },
    getMultiFactorResolver: () => resolver,
    signInWithEmailAndPassword: async (_, email, password) => {
      calls.push(["signIn", email]);
      if (email === "setup@example.com") throw fail("auth/api-key-not-valid.-please-pass-a-valid-api-key.");
      if (email !== "ann@example.com" || password !== "right password") throw fail("auth/invalid-credential");
      if (enrolled.length) throw fail("auth/multi-factor-auth-required");
      auth.currentUser = user;
      return { user };
    },
    createUserWithEmailAndPassword: async (_, email) => {
      if (email === "ann@example.com") throw fail("auth/email-already-in-use");
      auth.currentUser = { ...user, email, displayName: "" };
      return { user: auth.currentUser };
    },
    updateProfile: async (u, profile) => calls.push(["updateProfile", profile.displayName]),
    sendEmailVerification: async () => calls.push(["sendEmailVerification"]),
    signInWithRedirect: async (_, provider) => calls.push(["redirect", provider.id]),
    getRedirectResult: async () => {
      if (redirect === "mfa") throw fail("auth/multi-factor-auth-required");
      if (redirect === "ok") {
        auth.currentUser = user;
        return { user };
      }
      return null;
    },
    multiFactor: () => ({
      enrolledFactors: enrolled,
      getSession: async () => "session",
      enroll: async assertion => {
        if (assertion.code !== "123456") throw fail("auth/invalid-verification-code");
        enrolled = [{ uid: "f1", factorId: "totp" }];
        secondFactor = "totp";
      },
    }),
    applyActionCode: async (_, code) => calls.push(["applyActionCode", code]),
    signOut: async () => {
      auth.currentUser = null;
      calls.push(["signOut"]);
    },
  };
  return { sdk, calls, auth };
}

test("signing in gives an ID token and is remembered while Firebase restores the session", async () => {
  const storage = memoryStorage();
  const { sdk, auth } = fakeFirebase();
  const client = createFirebaseAuth({ sdk, storage });
  assert.equal(client.signedIn(), false);
  assert.equal(await client.accessToken(), null);
  await client.signIn("ann@example.com", "right password");
  assert.equal(await client.accessToken(), "ID");
  auth.currentUser = null; // a reload, before Firebase has the session back
  assert.equal(client.signedIn(), true, "the hint answers at once");
  assert.equal(await client.accessToken(), null, "and is dropped once Firebase says nobody is signed in");
  assert.equal(client.signedIn(), false);
});

test("Firebase's refusals become the codes the pages already handle", async () => {
  const client = createFirebaseAuth({ sdk: fakeFirebase().sdk, storage: memoryStorage() });
  await assert.rejects(client.signIn("ann@example.com", "wrong"), { status: 401, code: "wrong_credentials" });
  await assert.rejects(client.signUp("Ann", "ann@example.com", "long enough password"), { code: "email_taken" });
  await assert.rejects(client.me(), { code: "signed_out" });
  // A Firebase project set up wrong says so, and keeps Firebase's own error for the console.
  const setup = await client.signIn("setup@example.com", "x").catch(reason => reason);
  assert.equal(setup.code, "misconfigured");
  assert.equal(setup.cause.code, "auth/api-key-not-valid.-please-pass-a-valid-api-key.");
});

test("with an authenticator, the first try asks for the code and the second finishes", async () => {
  const { sdk, calls } = fakeFirebase({ totp: true });
  const client = createFirebaseAuth({ sdk, storage: memoryStorage() });
  await assert.rejects(client.signIn("ann@example.com", "right password"), { code: "mfa_required" });
  await assert.rejects(client.signIn("ann@example.com", "right password", "000000"), { code: "wrong_code" });
  await client.signIn("ann@example.com", "right password", "123456");
  assert.equal(await client.accessToken(), "ID-TOTP");
  assert.equal(calls.filter(([name]) => name === "signIn").length, 1, "the password is sent once; the code finishes that sign-in");
  // With nothing waiting, a code alone signs nobody in.
  await client.signOut();
  await assert.rejects(client.verifyMfa("123456"), { code: "signin_again" });
});

test("Google comes back through Firebase's redirect, and asks for the code when one is set up", async () => {
  const plain = fakeFirebase({ redirect: "ok" });
  const client = createFirebaseAuth({ sdk: plain.sdk, storage: memoryStorage(), providers: ["google"] });
  assert.deepEqual(await client.providers(), { google: true });
  await client.startProvider("google", "website");
  assert.deepEqual(plain.calls.at(-1), ["redirect", "google.com"]);
  assert.equal(await client.finishProvider(), true);
  assert.equal(client.signedIn(), true);
  await assert.rejects(client.startProvider("google", "desktop"), { code: "unavailable" }, "a browser page has no desktop sign-in");

  const guarded = createFirebaseAuth({ sdk: fakeFirebase({ totp: true, redirect: "mfa" }).sdk, storage: memoryStorage() });
  await assert.rejects(guarded.finishProvider(), { code: "mfa_required" });
  await guarded.verifyMfa("123456");
  assert.equal(await guarded.accessToken(), "ID-TOTP");

  const none = createFirebaseAuth({ sdk: fakeFirebase().sdk, storage: memoryStorage() });
  assert.equal(await none.finishProvider(), false);
});

test("an authenticator is set up with a key and a first code, and gives no recovery codes", async () => {
  const { sdk } = fakeFirebase();
  const client = createFirebaseAuth({ sdk, storage: memoryStorage() });
  await client.signIn("ann@example.com", "right password");
  assert.equal((await client.me()).mfa_enrolled, false);
  await assert.rejects(client.confirmMfa("123456"), { code: "no_setup" });
  const setup = await client.setupMfa();
  assert.deepEqual(setup, { secret: "SECRETKEY", otpauth_url: "otpauth://totp/Caller Whale:ann@example.com" });
  await assert.rejects(client.confirmMfa("000000"), { code: "wrong_code" });
  assert.deepEqual(await client.confirmMfa("123456"), { recovery_codes: [] });
  assert.equal((await client.me()).mfa_enrolled, true);
});

test("signing up names the account and sends the confirmation email", async () => {
  const { sdk, calls } = fakeFirebase();
  const client = createFirebaseAuth({ sdk, storage: memoryStorage() });
  await client.signUp("Bea Diaz", "bea@example.com", "long enough password");
  assert.ok(calls.some(([name, value]) => name === "updateProfile" && value === "Bea Diaz"));
  assert.ok(calls.some(([name]) => name === "sendEmailVerification"));
  assert.deepEqual(calls.at(-1), ["getIdToken", true], "a fresh token carries the name");
  await client.verifyEmail("oob-1");
  assert.ok(calls.some(([name, value]) => name === "applyActionCode" && value === "oob-1"));
});

test("in the desktop app, Google's token from the browser signs in to Firebase", async () => {
  const plain = fakeFirebase();
  const asked = [];
  const desktopSignIn = async name => (asked.push(name), "GOOGLE-ID-TOKEN");
  const client = createFirebaseAuth({ sdk: { ...plain.sdk, getRedirectResult: undefined, signInWithRedirect: undefined }, storage: memoryStorage(), desktopSignIn });
  assert.equal(await client.finishProvider(), false, "nothing to come back from");
  await client.startProvider("google", "desktop");
  assert.deepEqual(asked, ["google"]);
  assert.deepEqual(plain.calls.at(-1), ["credential", "GOOGLE-ID-TOKEN"]);
  assert.equal(await client.accessToken(), "ID");
  await assert.rejects(client.startProvider("apple", "desktop"), { code: "unavailable" });

  // With an authenticator set up, the code finishes it.
  const guarded = createFirebaseAuth({ sdk: fakeFirebase({ totp: true }).sdk, storage: memoryStorage(), desktopSignIn });
  await assert.rejects(guarded.startProvider("google", "desktop"), { code: "mfa_required" });
  await guarded.verifyMfa("123456");
  assert.equal(await guarded.accessToken(), "ID-TOTP");

  // A browser sign-in that failed or was cancelled says why.
  const cancelled = createFirebaseAuth({ sdk: plain.sdk, storage: memoryStorage(), desktopSignIn: async () => Promise.reject(Object.assign(new Error("Sign-in was cancelled."), { code: "cancelled" })) });
  await assert.rejects(cancelled.startProvider("google", "desktop"), { message: "Sign-in was cancelled." });
});
