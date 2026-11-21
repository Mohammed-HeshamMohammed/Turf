# Settings and secrets

Every part of Caller Whale reads its settings, secrets included, from one file here. The real files are never committed (git ignores everything in this folder except this README and the `*.example` files), and no script or source file holds a secret of its own.

```bash
node tools/env-init.mjs     # from the repository root: creates each missing file from its example, with new random secrets
```

It never overwrites a file. Run it again after an example gains a setting, and it lists what each file is missing.

| File | Read by | Secrets in it |
| --- | --- | --- |
| `auth.env` | `services/auth/scripts/run-auth.sh` | `AUTH_SIGNING_KEY` (generated), `AUTH_GOOGLE_CLIENT_SECRET`, `AUTH_APPLE_PRIVATE_KEY` |
| `desktop.env` | the desktop app and the CRM (`vite.config.mjs`), when built or served | None that are server secrets: everything here ships inside the app |
| `compose.env` | `docker compose --env-file env/compose.env -f deploy/compose.yml` | `POSTGRES_PASSWORD`, `AUTH_SIGNING_KEY` (generated) |
| `gateway.env` | the gateway (`services/gateway`), when run locally | None |
| `*.production.example` | Coolify: the values to paste into each application's Environment Variables, Developer View (`auth`, `gateway`, `landing-web`, `grafana`). Fill every `<...>`; keep secrets in Coolify, never in the repository | Marked `<...>` |
| `firebase.env` | `tools/firebase/configure-auth.mjs` (one-time Firebase project setup for the auth service) | `FIREBASE_SERVICE_ACCOUNT`: the key's JSON itself, not the path of a downloaded key file |

A setting already in the environment wins over the file, so a deploy can set any of them its own way.

Production does not use these files: each server's secrets come from its host's secret store as environment variables with the same names.

## Recoverable container notes

`container-notes.json` is the versioned, secret-free explanation catalog for the
Caller Whale containers. Its `resources` object is keyed by actual Coolify resource
names. Each resource has a `description`, source references, and a `variables`
object mapping environment names to a single-line comment of at most 240 characters.
It contains explanations, never stored environment values or credentials.
`container-variable-inventory.json` records only the names observed in Coolify and
the observation date; it is a point-in-time inventory, not a live configuration dump.

From the repository root, run:

```sh
node tools/env-notes.mjs check
node tools/env-notes.mjs render auth
node tools/env-notes.mjs render callerwhale-monitoring
```

The checker verifies catalog coverage of the observed inventory, comment length,
and the exact catalog comment immediately above each production-example assignment
and each monitoring Compose environment entry. It reads only the catalog, key-only
inventory, example files and monitoring Compose file, never real `.env` files or
Coolify credentials. Update the inventory when live keys change, then add notes and
rerun the check. This is a local guard, not a continuously running Coolify policy.

`render` produces comments followed by `KEY=<set-in-coolify>` placeholders. It is
a reference template, **not a live-environment replacement**. Copy only the comment
text into the matching variable's native **Comment** field in Coolify; preserve its
value and existing build-time/runtime flags. Plain `#` lines pasted into Developer
View are not a substitute for native comments because they are not retained as
variable metadata. Save and reopen the variable to verify persistence.

Some monitoring variables are injected by Compose and appear read-only in Coolify,
without a Comment field. Their explanations live above the corresponding entries
in `deploy/grafana/compose.yml` and in this catalog. For editable monitoring inputs,
use native Comment fields. The catalog also explains generated Coolify keys that
do not occur in the repository Compose file; it does not assert that a generated
key is consumed by that file. Native PostgreSQL resources have no observed env
entries: database/user/password are managed in their General settings. Do not add
invented `POSTGRES_*` variables to those resources just to attach comments.

Comments cannot be made undeletable to the Coolify owner or server administrator.
Coolify's value lock is not deletion protection, and would obstruct later value
changes; do not lock values for this purpose. Git history provides recovery of the
catalog and source comments. If a native comment disappears, find its resource/key
here and restore only that Comment field. An administrator can also remove Git
history, so this is recovery/versioning, not an immutable enforcement boundary.

The folder ignore rule intentionally excludes real environment files and allows
only the two named secret-free JSON files in addition to examples and this README.
Stage only the intended files:

```sh
git add env/container-notes.json env/container-variable-inventory.json
```

Do not force-add the whole `env/` folder. Normal Git updates retain the catalog
and inventory while real secret files remain ignored.


## Database setup and updates

- `DATABASE_URL`: the application's restricted connection for ordinary reads and writes.
- `DATABASE_SETUP_URL`: the schema owner's connection, used only to create or update database structure.
- `CORE_API_DATABASE_SETUP_URL`: the same owner connection in local `database.env`, read by the configuration generator.
- `TEST_DATABASE_SETUP_URL`: the owner connection to a dedicated test database.
- `database_setup/`: the ordered SQL scripts shipped with a service or the desktop project store.
- `database_setup_history`: records completed scripts so restarting does not run them again.



## Container health reporting in Coolify

Auth ships its own Dockerfile health command.


The `Check container configuration notes` GitHub Actions workflow runs the catalog check on relevant main pushes and pull requests. It reports missing descriptions, undocumented observed keys, and removed or changed source comments. It does not monitor or prevent manual comment deletion in Coolify; use the versioned catalog to restore those native Comment fields.
