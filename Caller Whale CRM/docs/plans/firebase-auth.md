# Sign-in: the auth service, with Firebase behind it

**Current design (2026-10-30): the auth service is the only part of Caller Whale that knows Firebase.**

```
website / CRM / desktop app ──► auth service ──► Firebase (server API: passwords, email links, authenticator, Google)
        │                           │
        │                           └─ issues Caller Whale's own tokens (EdDSA) and a refresh token
        ▼
   gateway ──► core API        both check only the auth service's tokens, with its public keys (/.well-known/jwks.json)
```

- **Auth service** (`services/auth`, `AUTH_FIREBASE_API_KEY`): sign-up, sign-in, email confirmation, password change and reset, authenticator setup and sign-in, and Google all go to Firebase's server API (`src/firebase.rs`). It keeps a row per person (a UUID, the same in every service, with Firebase's uid beside it) and a row per session (with the Firebase refresh token, server side only). Without the key it keeps its own accounts as before. It makes the tokens: they carry `mfa` (the authenticator code was given), `auth_time` (when this session began) and `provider`.
- **Gateway, core API, Grafana proxy, landing site, desktop app**: no Firebase code, no Firebase settings, no Firebase address in their security policies. They sign in through the auth service and verify its tokens. A Firebase token is refused everywhere.
- **Firebase** is told nothing about Caller Whale's roles. Who may do what is the core API's decision.
- **Not carried over**: Apple sign-in (offered only without Firebase), recovery codes (Firebase has none: staff reset a lost authenticator).

## Firebase console, once

1. Authentication → Sign-in method: **Email/Password** on, **Google** on.
2. Authentication → Settings → upgrade to **Identity Platform**, then turn authenticator (TOTP) codes on with `node tools/firebase/configure-auth.mjs` (needs `env/firebase.env`).
3. Project settings → General: copy the **Web API key** into the auth service's `AUTH_FIREBASE_API_KEY`.
4. Google sign-in goes through the auth service's own Google login: Google Cloud → Credentials → the Web client Firebase made: add the redirect URI `https://auth.callerwhale.com/v1/oauth/google/callback`, and put its client id and secret in `AUTH_GOOGLE_CLIENT_ID` and `AUTH_GOOGLE_CLIENT_SECRET`.
5. The confirmation and password reset emails link to Firebase's own pages by default. That works; to send people to Caller Whale pages instead, set the action URL in Authentication → Templates, and the pages post the code to `POST /v1/email/verify` or `POST /v1/password/reset`.

## Where the settings live

| Setting | Where |
| --- | --- |
| `AUTH_FIREBASE_API_KEY` (and `AUTH_FIREBASE_IDENTITY_URL`, `AUTH_FIREBASE_TOKEN_URL` for tests) | auth service only |
| `AUTH_JWKS_URL` | gateway; `CALLERWHALE_AUTH_JWKS_URL` for the core API |
| `VITE_CALLERWHALE_AUTH_URL` | the desktop build |
| `AUTH_ORIGIN` | the landing container's security policy |

The sections below are the original plan, from when the clients were meant to sign in with Firebase directly. They are kept for the decisions behind Firebase; where they disagree with the above, the above is current.

---

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
Console steps and `tools/firebase/configure-auth.mjs` below. Two projects: `callerwhale-dev` and `callerwhale-prod`.

### 1. Core API accepts Firebase tokens (done)
- `callerwhale-auth-verify` gets a Firebase mode: RS256, issuer `https://securetoken.google.com/<project>`, audience `<project>`, keys from `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` (cached, refreshed when a `kid` is unknown).
- Claims map: `sub` → `firebase_uid`; `email`, `email_verified`, `name`; `mfa` = `firebase.sign_in_second_factor == "totp"`; `provider` = `firebase.sign_in_provider` without its ".com" ("password", "google", "apple").
- Database update: `users.firebase_uid`. Config: `CALLERWHALE_FIREBASE_PROJECT`. While both run, the core API accepts either issuer; the old one is removed in phase 5.
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

Apple returns to auth's registered HTTPS callback, which verifies the ID token and hashed nonce, hands the token and raw nonce to Firebase, and issues a single-use code to the desktop loopback listener. This server flow is covered by fake-provider tests; live Apple sign-in still requires an Apple Developer configuration and a real-device check.

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

Done once per project (`callerwhale-dev`, then `callerwhale-prod`), signed in to the Firebase console as Caller Whale's owner.

1. **Create the project** at console.firebase.google.com. Google Analytics: off.
2. **Billing**: switch the project to the Blaze plan (needed for Identity Platform).
3. **Authentication → Get started**, then **Settings → Upgrade to Identity Platform**.
4. **Sign-in method**: turn on Email/Password (not the passwordless link), and Google (set the support email). Apple: later, it needs the Apple Developer account.
5. **Settings → Authorized domains**: keep `localhost`; add the production website's domain.
6. **Project settings → General → Add app → Web**: name it `Caller Whale`. Copy the config (`apiKey`, `authDomain`, `projectId`, `appId`) into the settings below. These values are public by design; the API key is not a secret.
7. **Google Cloud console → APIs & Services → Credentials**:
   - Restrict the web API key to the Identity Toolkit API and the Token Service API.
   - Create an OAuth client of type **Desktop app** named `Caller Whale desktop` (phase 3).
8. **Project settings → Service accounts → Generate new private key**. Put the key's JSON itself, on one line in single quotes, in `env/firebase.env` as `FIREBASE_SERVICE_ACCOUNT` (with `FIREBASE_PROJECT_ID`), then delete the downloaded file. It is a secret: it can change every account. Nothing reads a key file.
9. Run the configuration script (authenticator codes, password policy, email privacy):

   ```bash
   npm --prefix "Caller Whale CRM/tools/firebase" install
   node "Caller Whale CRM/tools/firebase/configure-auth.mjs"
   ```

   It prints the project's resulting configuration; check that TOTP shows `ENABLED`.

### Settings each part will read

All of them go in the part's file in `env/` (`env/README.md`); nothing is set in source files or read from key files.

| Where | Setting |
| --- | --- |
| Core API | `CALLERWHALE_FIREBASE_PROJECT` (the project id); `CALLERWHALE_FIREBASE_SERVICE_ACCOUNT` (the key's JSON, phase 4) |
| Desktop app, CRM | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, `VITE_FIREBASE_PROVIDERS`; `VITE_GOOGLE_DESKTOP_CLIENT_ID`, `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` |
| Core API, for the website | `CALLERWHALE_FIREBASE_API_KEY`, `CALLERWHALE_FIREBASE_APP_ID`; optionally `CALLERWHALE_FIREBASE_AUTH_DOMAIN`, `CALLERWHALE_FIREBASE_PROVIDERS` |
