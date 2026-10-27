// Signing in with Firebase Authentication (docs/plans/firebase-auth.md, phase 2), with the same functions as
// auth-client.js, so the website and the CRM change little whichever one a server uses. It takes the Firebase SDK's
// functions as `sdk` (the page imports them: see firebase-web-entry.js), so it has no imports of its own and its
// tests need no network. This is the original; the copy in desktop/frontend/react/src/remote/ must stay identical
// (sync.mjs), and the website gets it inside its bundle.
//
// Firebase keeps the person signed in itself (IndexedDB) and refreshes their ID token before it expires. The one
// thing it does not keep is a sign-in waiting for its authenticator code: that lives here, in memory, until the code
// arrives. Firebase gives no recovery codes; staff reset a lost authenticator.

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Set while someone is signed in, so `signedIn()` can answer at once while Firebase restores the session. */
const HINT_KEY = "turf.auth.firebase";

const WRONG = [401, "wrong_credentials", "That email and password do not match."];
const SETUP = [503, "misconfigured", "Sign-in is not set up correctly yet. Tell Turf's support."];
const REFUSALS = {
  // The server's Firebase settings, or the project in the Firebase console, are not right.
  "auth/api-key-not-valid.-please-pass-a-valid-api-key.": SETUP,
  "auth/invalid-api-key": SETUP,
  "auth/configuration-not-found": SETUP,
  "auth/operation-not-allowed": SETUP,
  "auth/unauthorized-domain": SETUP,
  "auth/invalid-credential": WRONG,
  "auth/wrong-password": WRONG,
  "auth/user-not-found": WRONG,
  "auth/invalid-email": [400, "invalid_email", "Enter a valid email address."],
  "auth/email-already-in-use": [409, "email_taken", "An account with this email already exists. Sign in instead."],
  "auth/weak-password": [400, "weak_password", "Use a password of at least 12 characters."],
  "auth/password-does-not-meet-requirements": [400, "weak_password", "Use a password of at least 12 characters."],
  "auth/too-many-requests": [429, "too_many_attempts", "Too many tries. Wait a few minutes and try again."],
  "auth/network-request-failed": [0, "offline", "The sign-in service cannot be reached. Check your connection."],
  "auth/invalid-verification-code": [400, "wrong_code", "That code is not right. Check the time on your phone and try again."],
  "auth/requires-recent-login": [401, "signin_again", "Sign in again, then try once more."],
  "auth/user-disabled": [403, "disabled", "This account is turned off."],
  "auth/multi-factor-auth-required": [401, "mfa_required", "Enter the code from your authenticator app."],
};

/** Firebase's error as an AuthError; Firebase's own stays as `cause`, for the console. */
const refusal = reason => {
  const known = REFUSALS[reason?.code];
  const error = known ? new AuthError(...known) : new AuthError(400, "error", "Sign-in was refused.");
  error.cause = reason;
  return error;
};

export function createFirebaseAuth({ sdk, storage = globalThis.localStorage, providers = [] }) {
  const auth = sdk.auth;
  /** A sign-in that needs its authenticator code: Firebase's resolver for it. */
  let pending = null;
  /** The authenticator secret being set up, until its first code confirms it. */
  let secret = null;

  const hint = on => {
    try {
      if (on) storage?.setItem(HINT_KEY, "1");
      else storage?.removeItem(HINT_KEY);
    } catch {
      /* Not remembered on this device: Firebase still restores the session. */
    }
  };
  const hinted = () => {
    try {
      return storage?.getItem(HINT_KEY) === "1";
    } catch {
      return false;
    }
  };
  const current = async () => {
    await auth.authStateReady();
    return auth.currentUser;
  };
  const signedInUser = async () => {
    const user = await current();
    if (!user) throw new AuthError(401, "signed_out", "Sign in first.");
    return user;
  };

  /** Runs `work`, turning Firebase's errors into AuthErrors; a sign-in that needs its code is kept for verifyMfa. */
  async function run(work) {
    try {
      return await work();
    } catch (reason) {
      if (reason instanceof AuthError) throw reason;
      if (reason?.code === "auth/multi-factor-auth-required") pending = sdk.getMultiFactorResolver(auth, reason);
      throw refusal(reason);
    }
  }

  const done = () => {
    pending = null;
    hint(true);
    return {};
  };

  /** Finishes the waiting sign-in with an authenticator code. A wrong code keeps it waiting for another try. */
  async function withCode(code) {
    if (!pending) throw new AuthError(401, "signin_again", "Sign in again, then enter your code.");
    const factor = pending.hints.find(item => item.factorId === sdk.TotpMultiFactorGenerator.FACTOR_ID);
    if (!factor) throw new AuthError(400, "no_authenticator", "This account has no authenticator app set up.");
    await pending.resolveSignIn(sdk.TotpMultiFactorGenerator.assertionForSignIn(factor.uid, code));
    return done();
  }

  const provider = name => (name === "apple" ? new sdk.OAuthProvider("apple.com") : new sdk.GoogleAuthProvider());

  async function signOut() {
    pending = null;
    secret = null;
    hint(false);
    await sdk.signOut(auth).catch(() => undefined);
  }

  return {
    base: "",
    signedIn: () => Boolean(auth.currentUser) || hinted(),
    /** A current ID token (Firebase refreshes it before it expires). Null when nobody is signed in. */
    accessToken: () =>
      run(async () => {
        const user = await current();
        if (!user) {
          hint(false);
          return null;
        }
        return user.getIdToken();
      }),
    /** A new ID token now, for instance after a server said the old one is no good. Null when nobody is signed in. */
    refresh: () =>
      run(async () => {
        const user = await current();
        return user ? user.getIdToken(true) : null;
      }),
    signUp: (name, email, password) =>
      run(async () => {
        const { user } = await sdk.createUserWithEmailAndPassword(auth, email, password);
        await sdk.updateProfile(user, { displayName: name });
        await sdk.sendEmailVerification(user).catch(() => undefined);
        // The next token carries the name.
        await user.getIdToken(true);
        return done();
      }),
    /** With an authenticator set up, the first try answers code "mfa_required"; try again with `code`. */
    signIn: (email, password, code) =>
      run(async () => {
        if (code && pending) return withCode(code);
        try {
          await sdk.signInWithEmailAndPassword(auth, email, password);
          return done();
        } catch (reason) {
          if (!code || reason?.code !== "auth/multi-factor-auth-required") throw reason;
          pending = sdk.getMultiFactorResolver(auth, reason);
          return withCode(code);
        }
      }),
    providers: async () => Object.fromEntries(providers.map(name => [name, true])),
    /** Google or Apple: this page goes there and comes back; `finishProvider` then completes the sign-in. */
    startProvider: (name, target) =>
      run(async () => {
        if (target === "desktop") throw new AuthError(400, "unavailable", "Google sign-in in the desktop app is coming. Use your email for now.");
        await sdk.signInWithRedirect(auth, provider(name));
      }),
    /** True when this page came back from Google or Apple signed in. Throws "mfa_required" when it needs the code. */
    finishProvider: () =>
      run(async () => {
        const result = await sdk.getRedirectResult(auth);
        if (!result) return false;
        done();
        return true;
      }),
    me: () =>
      run(async () => {
        const user = await signedInUser();
        return { id: user.uid, email: user.email, name: user.displayName || "", email_verified: user.emailVerified, mfa_enrolled: sdk.multiFactor(user).enrolledFactors.length > 0 };
      }),
    setupMfa: () =>
      run(async () => {
        const user = await signedInUser();
        secret = await sdk.TotpMultiFactorGenerator.generateSecret(await sdk.multiFactor(user).getSession());
        return { secret: secret.secretKey, otpauth_url: secret.generateQrCodeUrl(user.email, "Turf") };
      }),
    /**
     * Turns the authenticator on. There are no recovery codes. When Firebase's token does not yet say a code was
     * used, the person signs in once more with one, so Turf's server sees the second step.
     */
    confirmMfa: code =>
      run(async () => {
        if (!secret) throw new AuthError(400, "no_setup", "Start setting up the authenticator again.");
        const user = await signedInUser();
        await sdk.multiFactor(user).enroll(sdk.TotpMultiFactorGenerator.assertionForEnrollment(secret, code), "Authenticator app");
        secret = null;
        const { claims } = await user.getIdTokenResult(true);
        if (claims.firebase?.sign_in_second_factor !== "totp") {
          await signOut();
          throw new AuthError(401, "signin_again", "Your authenticator is set up. Sign in again with a code from it.");
        }
        return { recovery_codes: [] };
      }),
    /** The code for a sign-in that is waiting for one (after Google or Apple). */
    verifyMfa: code => run(() => withCode(code)),
    /** The code from Firebase's confirmation link (`oobCode`). */
    verifyEmail: token =>
      run(async () => {
        await sdk.applyActionCode(auth, token);
        const user = auth.currentUser;
        if (user) {
          await user.reload();
          await user.getIdToken(true);
        }
        return {};
      }),
    resendEmail: () =>
      run(async () => {
        await sdk.sendEmailVerification(await signedInUser());
        return {};
      }),
    signOut,
  };
}
