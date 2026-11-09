# Importing lists (server)

Python service on port 8111. The gateway sends upload start, chunk, resume and completion requests here, under the existing `gate.callerwhale.com` hostname. The worker keeps temporary pieces in its own persistent volume at `IMPORT_DIR` (default `/data/imports`) and writes original source rows plus processed values to PostgreSQL `importing` tables. CRM Core reads those tables for mapping, duplicate decisions and lead merge; it does not receive file bytes.

Set `DATABASE_URL` to the importer role, `CORE_URL` to the private CRM Core origin (default `http://crm-core:8107`), and mount a worker-only volume at `/data/imports`. The worker checks the bearer token, workspace and import capability against Core `/api/v1/me` for each upload request. The importer role cannot write CRM leads.

The upload is 8 MiB chunks with SHA-256 checks. Resume reports only pieces still present on worker storage; completion checks every piece before queueing. Loaded files are removed after their rows are stored. Cancelled, failed and abandoned uploads are swept from the worker volume.

Column review maps supported contact and property location headings into CRM fields. It also labels recognized source-only headings, such as building facts, mailing addresses, extra owners and export activity, while retaining their original values in PostgreSQL source rows. Source-only fields are not silently presented as populated CRM lead fields.

Run `python -m unittest discover -s tests` after installing `requirements.lock` (the exact versions the image uses; `requirements.txt` holds the allowed ranges); database integration tests require a disposable PostgreSQL configured through `CRM_TEST_ADMIN_URL`.
