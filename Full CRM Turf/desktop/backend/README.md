# Desktop backend

The Rust code the container links in: one library crate per feature under `features/`, in the same order as `docs/features`. Each is a scaffold today (`FEATURE` and `status()` with two tests) and grows as logic moves in from `src-tauri/` and the Python engine in `service/`.

Rules:

1. Works offline. Opening a list, running a check and exporting a file never need the server.
2. No window, no webview. A module is callable from a Tauri command and from a plain test.
3. One module per feature. Shared code goes in a `shared/` crate when two modules need the same thing, not in either module.

Run the tests of every module: `cargo test --workspace` from the `Full CRM Turf` folder.
