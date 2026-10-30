# AI campaigns

Feature 6 on the person's computer: drafts and approvals; sending happens on the server.

| | |
| --- | --- |
| Part | Desktop backend module (runs on the person's computer) |
| Language | Rust (a library crate the container links in) |
| Owns data | No (it reads and writes the local workspace through the desktop backend) |
| Status | Scaffold: it starts, answers `/healthz` and `/version`, and has one test. No business logic yet |

## Run and test

```bash
cargo test -p callerwhale-desktop-ai-campaigns
```

## What it must do

- Never need the server to do its job: opening, checking and exporting must work offline.
- Keep every function callable from a Tauri command in `desktop/container/rust` and from tests, with no window.
- Share nothing with the other modules except through the desktop backend crate.

## Data

A desktop module uses the person's local workspace and files only. It must work with no connection.
