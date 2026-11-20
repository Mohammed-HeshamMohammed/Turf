# Importing lists (server)

Python service on port 8111. The gateway sends upload start, chunk, resume and completion requests here, under the existing `gate.callerwhale.com` hostname. The worker keeps temporary pieces in its own persistent volume at `IMPORT_DIR` (default `/data/imports`) and writes original source rows plus processed values to PostgreSQL `importing` tables. CRM Core reads those tables for mapping, duplicate decisions and lead merge; it does not receive file bytes.

Set `DATABASE_URL` to the importer role, `CORE_URL` to the private CRM Core origin (default `http://crm-core:8107`), and mount a worker-only volume at `/data/imports`. The worker checks the bearer token, workspace and import capability against Core `/api/v1/me` for each upload request. The importer role cannot write CRM leads.

The upload is 1 MiB chunks with SHA-256 checks. Resume reports only pieces still present on worker storage; completion checks every piece before queueing.

The columns are asked about before any row is stored. The worker first reads the file once without storing it (headings, how many rows fill each column, a sample) and asks the person what each column is. Columns with nothing in them and columns about the owner's relatives ("Relative 3 MOBILE 2") are not offered. After the answer it reads the file again and stores only the columns that were kept, each row written once and already tidied; then it looks for repeats. Columns that were not kept are not stored.

The uploaded file is kept for `IMPORT_KEEP_FILE_DAYS` (default 30) after it arrives and is then deleted; the report carries the date (`file_kept_until`) and the screens show it. A list whose columns are still unanswered when its file goes is cancelled. Files of cancelled and failed imports are removed at once.

Tidying, as the rows are loaded: phone numbers are checked (made-up numbers and, for ten-digit North American numbers, area codes that do not exist are left out; the plan comes from Google's libphonenumber, `IMPORT_PHONE_REGION`, default US). A lead gets the best phone to call (a mobile before a landline before VoIP, read from headings like "Owner MOBILE 1") and keeps every owner, phone and email beside it in `contacts`. A name cell that holds two owners ("John & Mary Smith") is two owners of one lead.

Repeats: a lead is an owner and a property. The same name with the same phone, email or address is a repeat unless the rows are for different properties; names that are nearly the same on the same phone, email or address are asked about; street words and directions ("Street"/"St", "North"/"N") do not make two addresses. The address key is worked out in the worker (`address_key`) and in the database (`importing.addr_key`), and a test holds the two together.

`tools/bench.py` times an import from file to "ready", for a made-up list of N rows or a real file.

Run `python -m unittest discover -s tests` after installing `requirements.lock` (the exact versions the image uses; `requirements.txt` holds the allowed ranges); database integration tests require a disposable PostgreSQL configured through `CRM_TEST_ADMIN_URL`.
