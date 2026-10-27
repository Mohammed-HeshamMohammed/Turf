# Desktop container (Rust, Tauri 2)

The Tauri shell for Full CRM Turf, moved here from `src-tauri/` (history kept). See [desktop/README.md](../../README.md).

The container creates the window, registers the Tauri commands, handles sign-in and downloads, and manages the Skip Tracing engine as a child process (`src/sidecar.rs`). Business logic moves out of it into `desktop/backend/` modules over time; today `main.rs`, `sidecar.rs`, `signin.rs` and `downloads.rs` still live here.

**Sign-in with Google** happens in the person's own browser, never in the window. With the auth service, `google_sign_in_listen` waits on 127.0.0.1 for auth's one-time code. With Firebase, `google_sign_in` does Google's part itself: it opens Google with the Desktop OAuth client, PKCE and a random `state`, takes the code on `http://127.0.0.1:<port>`, checks the state, trades the code for Google's ID token and returns it, and the window signs in to Firebase with that token. The frontend passes the client from `VITE_GOOGLE_DESKTOP_CLIENT_ID` and `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` (Google does not treat a Desktop client's secret as secret). Apple is not offered in the desktop app: Apple does not send people back to this computer, so it needs a hosted page first.

**Content Security Policy** (`tauri.conf.json`): scripts only from the app itself, no frames, no plugins. Pictures from the app, `data:`/`blob:` and OpenStreetMap's tiles. Connections to the app, Tauri, any `https:`/`wss:` server and this computer: Turf's server address is chosen when the app is built, so the policy cannot name it. Styles allow inline (libraries set them at run time), and Tauri is told not to add nonces to `style-src`, which would switch that off. `devCsp` also allows Vite's inline scripts for `npm run desktop`.

## Run

From `desktop/frontend/react`:

```bash
npm run desktop           # signed-in mode (needs a Turf server)
npm run desktop:sample    # sample workspace, no server
cargo test --manifest-path ../../container/rust/Cargo.toml
```

The Tauri CLI finds `tauri.conf.json` in this folder by itself. Two paths in it are relative to this folder:

- `beforeDevCommand` and `beforeBuildCommand` run in `../../frontend/react` (the folder with `package.json`), and `frontendDist` is `../../frontend/react/dist/client`.
- The Python engine is found at `../../../../service` (the repository root's `service/`), or at `TURF_SERVICE_ROOT`.

The container keeps its own `Cargo.lock` and is left out of the root Cargo workspace, because it pulls in a large dependency tree.

Releases of the installer are built by the release workflow (planned, `crm/release-pipeline`).
