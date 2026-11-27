# Learning store

A separate service and database for what Caller Whale learns from imported lists. It keeps keyed hashes and shapes of leads, never the leads.

- Port 8112, no public address. crm-core sends it finished imports (`LEARNING_URL`, `LEARNING_TOKEN`).
- Its own PostgreSQL database; tables are created at start.
- `LEARNING_ENABLED=false` (the default) takes nothing in; erasure and opt-out still work.

API (bearer `LEARNING_TOKEN`): `POST /v1/ingest`, `POST /v1/outcomes`, `POST /v1/erase-person`, `POST /v1/workspaces/{org}/opt-out`, `POST /v1/workspaces/{org}/opt-in`, `DELETE /v1/workspaces/{org}`, `GET /healthz`.

Tests: `go test ./...`; the database test runs with `LEARNING_TEST_URL=postgres://user@host:5432/emptydb`.
