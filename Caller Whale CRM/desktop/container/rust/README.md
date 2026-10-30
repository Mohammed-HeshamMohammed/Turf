# Desktop container (Rust, Tauri 2)

The Tauri shell for Caller Whale CRM, moved here from `src-tauri/` (history kept). See [desktop/README.md](../../README.md).

The container creates the window, registers the Tauri commands, handles sign-in and downloads, and manages the Skip Tracing engine as a child process (`src/sidecar.rs`). Business logic moves out of it into `desktop/backend/` modules over time; today `main.rs`, `sidecar.rs`, `signin.rs` and `downloads.rs` still live here.

**Sign-in with Google** happens in the person's own browser, never in the window. With the auth service, `google_sign_in_listen` waits on 127.0.0.1 for auth's one-time code. With Firebase, `google_sign_in` does Google's part itself: it opens Google with the Desktop OAuth client, PKCE and a random `state`, takes the code on `http://127.0.0.1:<port>`, checks the state, trades the code for Google's ID token and returns it, and the window signs in to Firebase with that token. The frontend passes the client from `VITE_GOOGLE_DESKTOP_CLIENT_ID` and `VITE_GOOGLE_DESKTOP_CLIENT_SECRET` (Google does not treat a Desktop client's secret as secret). Apple is not offered in the desktop app: Apple does not send people back to this computer, so it needs a hosted page first.

**Content Security Policy** (`tauri.conf.json`): scripts only from the app itself, no frames, no plugins. Pictures from the app, `data:`/`blob:` and OpenStreetMap's tiles. Connections to the app, Tauri, any `https:`/`wss:` server and this computer: Caller Whale's server address is chosen when the app is built, so the policy cannot name it. Styles allow inline (libraries set them at run time), and Tauri is told not to add nonces to `style-src`, which would switch that off. `devCsp` also allows Vite's inline scripts for `npm run desktop`.

## Run

From `desktop/frontend/react`:

```bash
npm run desktop           # signed-in mode (needs a Caller Whale server)
npm run desktop:sample    # sample workspace, no server
cargo test --manifest-path ../../container/rust/Cargo.toml
```

The Tauri CLI finds `tauri.conf.json` in this folder by itself. Two paths in it are relative to this folder:

- `beforeDevCommand` and `beforeBuildCommand` run in `../../frontend/react` (the folder with `package.json`), and `frontendDist` is `../../frontend/react/dist/client`.
- The Python engine is found at `../../../../service` (the repository root's `service/`), or at `CALLERWHALE_SERVICE_ROOT`.

The container keeps its own `Cargo.lock` and is left out of the root Cargo workspace, because it pulls in a large dependency tree.

## Releases and updates

The root `.github/workflows/release-crm.yml` builds the Windows NSIS installer when a `crm-v<version>` tag is pushed, or when dispatched with a version. Every release also includes the installer's `.sig` and `latest.json`. It uploads all assets to a draft before publishing and marking that release latest, so the update feed never points to an unfinished release. Published versions cannot be overwritten: bump the version instead.

The main window checks the GitHub `releases/latest/download/latest.json` feed at startup, every 30 minutes, and when returning to the app or reconnecting (at most once every five minutes). **Check for updates** is also available at sign-in. **Install and restart** downloads the update, verifies its signature, checks that calls are finished and changes synced, then installs. The local sample workspace is saved before installation; signed-in records stay in their encrypted vault. Windows closes the app and its bundled engine and starts the new version through the installer. Browser previews do not check or install updates.

The public verification key is in `tauri.conf.json`. Its matching private key is the repository Actions secret `TAURI_SIGNING_PRIVATE_KEY`; keep that secret across releases. `tauri.package.conf.json` enables signed updater artifacts. A release without the signing key fails before building. Never generate a different key for an ordinary release: existing installations trust the current key.

Versions 0.1.3 and earlier have no updater. Those users need to install 0.1.4 once; subsequent stable releases are offered in the app. The app is named Caller Whale with the identifier `com.callerwhale.crm` (it was Caller Whale Full CRM, `local.callerwhale.fullcrm`). The installer and the app data folder follow the identifier, so the first Caller Whale release installs as a new app next to the old one and starts with no local data; the old app can be uninstalled. Updates currently target Windows x64, matching the release workflow.
