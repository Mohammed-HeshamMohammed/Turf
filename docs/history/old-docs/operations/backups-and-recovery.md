# Backups and recovery

Build step 41 of the people, teams, chats and clients plan (D296-D299, D370). Written 2026-11-18. The Coolify backup settings
themselves could not be read from here (Cloudflare's check), so the setup below is what to do and then confirm.

## Daily backups, off the server, kept 30 days (D296, D370)

Coolify's own scheduled backups do this; nothing custom runs them.

1. **Storage outside the VPS.** In Coolify: Storages → add an S3-compatible bucket (Cloudflare R2, Backblaze B2, Hetzner Object
   Storage or AWS S3) in an EU region in the same country as the server, now France (D298). Give it its own access key that can only reach that bucket, and
   turn on the bucket's versioning lock or object lock if the provider has it, so a stolen Coolify key cannot erase backups.
2. **Every database.** For each PostgreSQL in the project's "database" environment (the auth database, the CRM database, which also
   holds billing, authz, the dialer and imports, and the messaging/chats database if it is separate): Backups → add a scheduled
   backup, every day at 03:00 (`0 3 * * *`), to that storage, keeping 30 backups locally and in S3 (or 30 days).
3. **Check the next morning** that a file for each database is in the bucket.

Data deleted on a person's request leaves the backups within 30 days as the old files expire; a restore deletes it again (below).

## The monthly restore test (D296)

Once a month, for each database: download the newest backup file from the bucket, and restore it into a throwaway database with

```
node tools/restore-test.mjs --dump <file> --scratch postgres://…/restore_scratch --expect crm.leads --log restore-tests.jsonl
```

It wipes the scratch database, restores the file with `pg_restore` (or `psql` for a `.sql` file), counts every table's rows, and
fails when nothing came back, an expected table is missing, or the newest row is older than two days. Keep `restore-tests.jsonl`
as the record that the test was done. Useful `--expect` tables: `crm.leads` and `crm.tasks` (CRM), `users` (auth),
`dialer_sms.calls` (dialer), `billing.subscriptions` (billing).

## Restoring one agency (D297, D370)

1. Restore the CRM backup of the chosen day into a separate database, the restore copy, owned by the same login crm-core uses
   (`pg_restore --no-owner --role=<crm-core login> -d <copy> <file>`), and set crm-core's `RESTORE_COPY_URL` to it.
2. Staff ask: `POST /api/v1/platform/restores {org_id, backup_date, reason}`. The agency's owners get a task.
3. The owner confirms with their second step: `POST /api/v1/restores/{id}/confirm`.
4. Staff run it: `POST /api/v1/platform/restores/{id}/run`. crm-core brings the copy up to its own version, then in one
   transaction replaces the agency's rows in every agency table with the copy's. Row security limits both sides to that agency.
   The agency's block list never goes backwards, leads of numbers deleted on a person's request are deleted again, and every
   device of the agency starts over. The request keeps how many rows each table holds now.
5. Unset `RESTORE_COPY_URL` and drop the copy.

Not restored this way: the sync log and operation records (devices start over instead), and what lives outside the CRM's agency
tables (imports waiting in the import worker, calls and texts in the dialer, chats, sign-in accounts).

## Where data lives (D298)

The server is in Paris, France (owner, 2026-11-18). The owner is thinking of moving it to Germany for a better connection to
Telnyx. Either way the data stays in the European Union, so the terms and privacy notice can say "the European Union (currently
France)" and, the lawyer to confirm, need only the country updated after a move. The backup bucket goes in the same country as the server
(an EU region of the storage provider). Calls and texts reach US leads through Telnyx, so call quality depends on the path from the
server to Telnyx's nearest point of presence; measure it from each candidate location before moving. A US region can be added
later for agencies that require it.

## A second server (D299)

Planned, not needed to open. In order: (1) a standby copy of each PostgreSQL by streaming replication on a second machine, or a
managed PostgreSQL with failover; (2) the dialer and messaging run on both machines behind the gateway, so one failure does not
stop calling and texting; (3) the gateway and the stateless services get a second copy. See `scaling-and-deployment.md`.
