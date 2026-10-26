# Desktop container (Rust, Tauri 2)

Placeholder for the move of `src-tauri/` here. See [desktop/README.md](../../README.md) for the plan.

The container is a shell: it creates the window, registers the Tauri commands that `desktop/backend/` defines, handles microphone permission for calls and captions, and packages the installer. It holds no business logic.

Releases of the installer are built by the release workflow (`.github/workflows/release-desktop.yml`, planned as Phase 2) when you ask for one.
