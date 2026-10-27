# Desktop container (Rust, Tauri 2)

The Tauri shell for Full CRM Turf, moved here from `src-tauri/` (history kept). See [desktop/README.md](../../README.md).

The container creates the window, registers the Tauri commands, handles sign-in and downloads, and manages the Skip Tracing engine as a child process (`src/sidecar.rs`). Business logic moves out of it into `desktop/backend/` modules over time; today `main.rs`, `sidecar.rs`, `signin.rs` and `downloads.rs` still live here.

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
