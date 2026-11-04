# Landing site

The public page of Caller Whale: a home page and the account pages (sign in, sign up, forgot password, account), signing in through the auth service (`services/auth`). React + Vite in the desktop app's style; no secrets.

| Setting | Meaning |
| --- | --- |
| `VITE_CALLERWHALE_AUTH_URL` | Auth service address, set at build. Development default `http://localhost:8101` |

```bash
npm --prefix landing/site run dev      # http://localhost:5200
npm --prefix landing/site run build    # landing/site/dist
```

`src/auth/auth-client.js` and `human-check.jsx` are copies of `services/auth/clients/`, kept in step by `node services/auth/clients/sync.mjs`. When the auth service has bot protection on, the forms load the invisible human check on their own.

Sign-up answers "by invitation" while the auth service has `AUTH_PUBLIC_SIGNUP=false`. Google sign-in comes back to `/signin` (`AUTH_LANDING_URL` on the auth service). Deploy: Dockerfile in this folder, port 8080.

**State.** The page follows who is signed in: the header and home page wait until that is known, someone signed in is sent away from the sign-in pages, nobody signed in is sent from `/account` to sign in, and a sign-in or sign-out in another tab (or a session the server ended) is picked up at once, with a note on the sign-in page when the session ended. The rules are in `src/guard.js`.

**Security.** nginx sends a content security policy that lets the page talk only to the auth service, plus clickjacking, content-type, referrer, permissions and HSTS headers. `scripts/security-headers.mjs` writes them when the image is built, from the same `VITE_CALLERWHALE_AUTH_URL`, and the build stops if it is missing, not https, or has a path. `npm test` runs the checks (also in the image build). If the auth service turns on the human check (reCAPTCHA), the policy already allows Google's script and frame.
