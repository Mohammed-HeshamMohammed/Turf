# Desktop frontend (React)

Placeholder for the move of `src/` here. See [desktop/README.md](../../README.md) for the plan.

Every screen the person sees. It reaches the computer only through `src/clients/local.js` (Tauri commands) and the servers only through `src/clients/server/` (the gateway at `/api/v1/<service>/`). A screen never calls `fetch` or `invoke` itself.
