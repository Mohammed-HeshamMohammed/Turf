# SpiceDB for the authorization service

SpiceDB holds Caller Whale's rules for who may do what: workspaces, roles, members, restrictions, teams, projects and staff.
Only the authorization service (`services/authz`) talks to it. It has no domain and no published port.

Deploy `deploy/spicedb/compose.yml` from the `spicedb-production` branch as a Git Docker Compose resource in Coolify.

1. Create SpiceDB's own database and login in PostgreSQL (`callerwhale_spicedb`), owned by that login. No other service uses it.
2. Set `SPICEDB_DATASTORE_CONN_URI` (that login's internal PostgreSQL address) and `SPICEDB_GRPC_PRESHARED_KEY` (a long random
   string) in Coolify only.
3. Deploy. The `migrate` service brings SpiceDB's tables up to date and exits; then `spicedb` starts on `spicedb:50051`.
4. Give authz the same key (`SPICEDB_PRESHARED_KEY`) and `SPICEDB_ENDPOINT=spicedb:50051`.

The image is pinned (`authzed/spicedb:v1.57.0`). To upgrade, change the tag in both services; `migrate` runs the new version's
datastore updates before the new server starts.
