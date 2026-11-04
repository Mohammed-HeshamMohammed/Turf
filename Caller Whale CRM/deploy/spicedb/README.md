# SpiceDB for the authorization service

SpiceDB holds Caller Whale's rules for who may do what: workspaces, roles, members, restrictions, teams, projects and staff.
It is a database server, so it lives in Coolify's **Database** environment next to PostgreSQL, not in the backend environment.
It has no branch and no compose file: it is a plain Docker Image resource. Only the authorization service (`services/authz`)
talks to it. It has no domain and no published port.

## Create it

1. In PostgreSQL create SpiceDB's own database and login (`callerwhale_spicedb`), owned by that login. No other service uses it.
2. In Coolify's Database environment add a resource: Docker Image `authzed/spicedb`, tag `v1.57.0`, same server and network as
   the backend. No domain, no ports exposed. Under Network, set the network alias `spicedb`.
3. Set the variables listed in `env/spicedb.production.example`.
4. Run the migration once: set the start command to `datastore migrate head`, deploy, wait for it to exit with success, then
   set the start command to `serve` and deploy again. SpiceDB now answers on `spicedb:50051`.
5. Give authz the same key (`SPICEDB_PRESHARED_KEY`) and `SPICEDB_ENDPOINT=spicedb:50051`.

## Upgrade

Change the image tag. Before the new server runs, repeat step 4 (`datastore migrate head`) so its tables are up to date.

## Locally

`deploy/compose.yml` already runs `serve-testing` (in memory, key `local`); nothing else is needed.
