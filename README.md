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
