# Importing lists (the upload service)

Python service on port 8111. The gateway sends upload start, chunk, resume and completion requests here, under the existing `gate.callerwhale.com` hostname. It keeps the pieces in its own persistent volume at `IMPORT_DIR` (default `/data/imports`) and records each one in the PostgreSQL `importing` tables. It does not read or load the lists: that is the importing worker's job ([services/importing-worker](../importing-worker/README.md)), a container of its own since split 1. CRM Core reads the `importing` tables for mapping, duplicate decisions and lead merge; it does not receive file bytes.

Set `DATABASE_URL` to the importer role, `CORE_URL` to the private CRM Core origin (default `http://crm-core:8107`), `IMPORT_FILE_TOKEN` to the secret it shares with the worker, and mount this application's own volume at `/data/imports`. It checks the bearer token, workspace and import capability against Core `/api/v1/me` for each upload request. The importer role cannot write CRM leads.

The upload is 1 MiB chunks with SHA-256 checks. Resume reports only pieces still present on this service's storage; completion checks every piece before queueing.

## For the worker

Three private routes, used only by the importing worker with the header `x-import-token: $IMPORT_FILE_TOKEN` (without the token set they are off; the gateway never forwards them):

- `GET /internal/jobs/<id>/files`: the pieces kept for an upload and their sizes.
- `GET /internal/jobs/<id>/files/<name>`: one piece (`<n>.part`), or a list joined before the split (`source.csv`, `source.utf8.csv`...).
- `DELETE /internal/jobs/<id>/files`: the worker has the upload; the copy here goes.

Every ten minutes it also removes the files of uploads that are cancelled, failed or older than `IMPORT_KEEP_FILE_DAYS` (default 30).

Run `python -m unittest discover -s tests` after installing `requirements.lock` (the exact versions the image uses; `requirements.txt` holds the allowed ranges).
