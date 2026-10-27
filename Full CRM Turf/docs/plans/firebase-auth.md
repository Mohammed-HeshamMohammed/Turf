# Sign-in on Firebase Authentication

**Status:** Approved. Phases 1 to 3 done (the core API accepts Firebase tokens; the website, the CRM and the desktop app sign in with Firebase when given a project; Google in the desktop app goes through the browser); phase 0 waits for the Firebase project
**Date:** 2026-10-27
**Replaces:** `services/auth` (the Rust sign-in service). Amends rule 3 of `service-architecture.md`: tokens are signed by Firebase (RS256, Google's keys), not by our own service.

Only sign-in moves. CRM data stays in PostgreSQL; Firestore is not used.

## What changes hands

| Job | Today (`services/auth`) | With Firebase |
| --- | --- | --- |
| Email and password accounts | Argon2id, 12+ characters | Firebase; password policy set to 12+ characters |
| Google and Apple | Our own OAuth code | Firebase providers |
| Authenticator codes | Ours, with 10 recovery codes | Firebase TOTP (needs Identity Platform). **No recovery codes**: staff reset a lost device from the admin dashboard |
| Too many wrong passwords | 5 per email in 15 minutes | Firebase's own abuse protection, plus reCAPTCHA if needed |
| Email confirmation, password reset | Confirmation only, emails not sent yet | Firebase sends both |
| Sessions | One per device, closed at once | Refresh tokens revoked per person; an ID token lives up to 1 hour |
| Who gets into a workspace | Core API | Core API, unchanged: invitations, roles, end dates, suspensions |
| Turning someone's access off | Core API, at once | Core API, at once (it already checks the person on every request); Firebase account disabled too |

## The id problem, and the answer

Every table in the core API keys people by `users.id` (a UUID), and today auth's token carries that UUID. A Firebase uid is a string Firebase picks.

- Add `users.firebase_uid text UNIQUE`. The core API finds the person by it on every request and creates the `users` row the first time (as it does now).
- Existing accounts are imported into Firebase **with their current UUID as the uid**, so `firebase_uid = id::text` for them and nothing else moves.

## Phases

### 0. Firebase project (this commit)
Console steps and `tools/firebase/configure-auth.mjs` below. Two projects: `turf-dev` and `turf-prod`.

### 1. Core API accepts Firebase tokens (done)
- `turf-auth-verify` gets a Firebase mode: RS256, issuer `https://securetoken.google.com/<project>`, audience `<project>`, keys from `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` (cached, refreshed when a `kid` is unknown).
- Claims map: `sub` → `firebase_uid`; `email`, `email_verified`, `name`; `mfa` = `firebase.sign_in_second_factor == "totp"`; `provider` = `firebase.sign_in_provider` without its ".com" ("password", "google", "apple").
- Migration: `users.firebase_uid`. Config: `TURF_FIREBASE_PROJECT`. While both run, the core API accepts either issuer; the old one is removed in phase 5.
- Tests: the harness signs RS256 test tokens shaped like Firebase's, against a test key set, as it does today with Ed25519.

### 2. One client file over the Firebase SDK (done)
`auth-client.js` is rewritten on the Firebase JS SDK with **the same functions** (`signIn`, `signUp`, `signOut`, `accessToken`, `refresh`, `me`, `setupMfa`, `confirmMfa`, `verifyMfa`, `providers`), so the desktop app, the CRM and the website change little.
- The SDK is bundled into `website/firebase-auth.js`; the website's policy adds Firebase's two sign-in APIs to `connect-src`, `https://apis.google.com` to `script-src` (Firebase loads it for Google sign-in) and the project's sign-in domain as `frame-src`.
- `setupMfa` returns the setup key and `otpauth://` link from `TotpMultiFactorGenerator`; `confirmMfa` returns no recovery codes, and the screens that showed them say what to do instead.

### 3. Desktop sign-in with Google (done), and Apple
Firebase's popup and redirect do not work inside the Tauri window, and Google blocks embedded sign-in. The container already listens on `127.0.0.1:<port>` (`desktop/container/rust/src/signin.rs`); it is kept:
1. The app opens the person's browser at Google with a **Desktop** OAuth client, PKCE, and `redirect_uri=http://127.0.0.1:<port>`.
2. The listener receives the code; the app trades it for Google's ID token.
3. `signInWithCredential(GoogleAuthProvider.credential(idToken))` signs in to Firebase.
Steps 1 and 2 run in the container (`google_sign_in` in `desktop/container/rust/src/signin.rs`), which also checks the `state`; the window does step 3. In the window Firebase starts without its redirect helper, so it loads nothing of Google's.

The Google ID token's audience is the Desktop client. If Firebase refuses it, add that client id under **Authentication → Sign-in method → Google → Safelist client IDs**.

Apple is not done: Apple only returns to registered `https` addresses, not to `127.0.0.1`. It needs a page on Turf's website that signs in with Apple and hands the result to the app; it comes once the Apple Developer account exists and can be tested.

The desktop window's content security policy is on (`tauri.conf.json`): scripts only from the app itself, no frames.

### 4. Admin actions reach Firebase
The core API calls the Identity Toolkit REST API with a service account (signed JWT → access token; no official Rust SDK):
- Turning access off disables the Firebase account and revokes its refresh tokens.
- Staff can remove a lost authenticator (the replacement for recovery codes).
- Staff opening a customer workspace (`/platform/customers`) is unchanged: the owner signs up with Firebase and accepts the link.

### 5. Move accounts, switch over, delete `services/auth`
- Export auth's accounts to Firebase's import format: uid = current UUID, email, `emailVerified`, and Google and Apple links (`providerUserInfo`). Import with the Admin SDK `importUsers`.
- **Passwords cannot move** (Firebase cannot import Argon2id): password accounts get a reset email at the switch. **Authenticators cannot move**: staff set theirs up again at their next sign-in.
- Remove the old issuer from the core API, delete `services/auth`, its database and its deploy, and update `service-architecture.md` and the READMEs.

## Costs

Authenticator codes need **Google Cloud Identity Platform**, which needs the Blaze (pay as you go) plan. Identity Platform charges per monthly active user above its free tier; check the current prices on its pricing page before launch. SMS codes are not turned on, so there are no SMS charges.

## Firebase project setup

Done once per project (`turf-dev`, then `turf-prod`), signed in to the Firebase console as Turf's owner.

1. **Create the project** at console.firebase.google.com. Google Analytics: off.
2. **Billing**: switch the project to the Blaze plan (needed for Identity Platform).
3. **Authentication → Get started**, then **Settings → Upgrade to Identity Platform**.
4. **Sign-in method**: turn on Email/Password (not the passwordless link), and Google (set the support email). Apple: later, it needs the Apple Developer account.
5. **Settings → Authorized domains**: keep `localhost`; add the production website's domain.
6. **Project settings → General → Add app → Web**: name it `Turf`. Copy the config (`apiKey`, `authDomain`, `projectId`, `appId`) into the settings below. These values are public by design; the API key is not a secret.
7. **Google Cloud console → APIs & Services → Credentials**:
   - Restrict the web API key to the Identity Toolkit API and the Token Service API.
   - Create an OAuth client of type **Desktop app** named `Turf desktop` (phase 3).
8. **Project settings → Service accounts → Generate new private key**. Put the key's JSON itself, on one line in single quotes, in `env/firebase.env` as `FIREBASE_SERVICE_ACCOUNT` (with `FIREBASE_PROJECT_ID`), then delete the downloaded file. It is a secret: it can change every account. Nothing reads a key file.
9. Run the configuration script (authenticator codes, password policy, email privacy):

   ```bash
   npm --prefix "Full CRM Turf/tools/firebase" install
   node "Full CRM Turf/tools/firebase/configure-auth.mjs"
   ```

   It prints the project's resulting configuration; check that TOTP shows `ENABLED`.

### Settings each part will read

All of them go in the part's file in `env/` (`env/README.md`); nothing is set in source files or read from key files.

| Where | Setting |
| --- | --- |
| Core API | `TURF_FIREBASE_PROJECT` (the project id); `TURF_FIREBASE_SERVICE_ACCOUNT` (the key's JSON, phase 4) |
| Desktop app, CRM | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_PROVIDERS`; `VITE_GOOGLE_DESKTOP_CLIENT_ID`, `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` |
| Core API, for the website | `TURF_FIREBASE_API_KEY`, `TURF_FIREBASE_APP_ID`; optionally `TURF_FIREBASE_AUTH_DOMAIN`, `TURF_FIREBASE_PROVIDERS` |
