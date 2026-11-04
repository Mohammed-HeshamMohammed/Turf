# SpiceDB for the authorization service

SpiceDB holds Caller Whale's rules for who may do what: workspaces, roles, members, restrictions, teams, projects and staff.
It is a database server, so it lives in Coolify's **Database** environment next to PostgreSQL, not in the backend environment.
It has no branch and no compose file: it is a plain Docker Image resource. Only the authorization service (`services/authz`)
talks to it. It has no domain and no published port.

## Create it

1. In PostgreSQL create SpiceDB's own database and login (`callerwhale_spicedb`), owned by that login. No other service uses it.
2. In Coolify's Database environment add a resource: Docker Image `authzed/spicedb`, tag `v1.57.0`, same server and network as
   the backend. No domain or host port mapping. Under Network, set Ports exposes to `50051` and alias to `spicedb`.
3. Set the variables listed in `env/spicedb.production.example`.
4. In General → Container → Custom Docker options, enter `--entrypoint "spicedb datastore migrate head"`, save, and deploy.
   This one-shot container exits after migrating. Confirm the deployment log says the migration completed; Coolify may mark
   the application Exited because it is not a long-running server yet.
5. Replace that option with `--entrypoint "spicedb serve"`, save, and deploy again. SpiceDB now answers on `spicedb:50051`.
6. Give authz the same key (`SPICEDB_PRESHARED_KEY`) and `SPICEDB_ENDPOINT=spicedb:50051`.

## Upgrade

Change the image tag. Before the new server runs, repeat the one-shot migration in step 4 so its tables are up to date.

## Locally

`deploy/compose.yml` already runs `serve-testing` (in memory, key `local`); nothing else is needed.
