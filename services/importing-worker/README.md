# Importing worker

Python service on port 8119, its own container since split 1 (D389). It takes each queued upload, fetches it from the upload service ([services/importing-lists](../importing-lists/README.md)) over the private network, and writes original source rows plus processed values to the PostgreSQL `importing` tables. CRM Core reads those tables for mapping, duplicate decisions and lead merge. It has no public address: `/healthz` (503 when a worker loop has stopped), `/version`, and `/status` (how many lists it works on at once and which ones it is on now).

Set `DATABASE_URL` to the importer role, `IMPORT_FILE_TOKEN` to the same secret as the upload service's, `IMPORT_API_URL` if the upload service is not at `http://importing-lists:8111`, and mount this application's own volume at `/data/imports`. Without `IMPORT_FILE_TOKEN` nothing is fetched and the uploads are read from `IMPORT_DIR` only (one shared folder: local runs and the tests). `IMPORT_WORKERS` (default 3, at most 8) lists are worked on at the same time; jobs are claimed with `SKIP LOCKED`, so two workers never take the same one.

Fetching: the pieces come one by one, each checked against the size and SHA-256 recorded when it was uploaded; a piece already here is not fetched again, so a restart carries on. After the pieces are joined the worker tells the upload service to let its copy go. A list joined before the split comes over whole. Every call has a 30-second timeout and is tried three times.

The columns are asked about before any row is stored. The worker first reads the file once without storing it (headings, how many rows fill each column, a sample) and asks the person what each column is. Columns with nothing in them and columns about the owner's relatives ("Relative 3 MOBILE 2") are not offered. After the answer it reads the file again and stores only the columns that were kept, each row written once and already tidied; then it looks for repeats. Columns that were not kept are not stored.

The uploaded file is kept for `IMPORT_KEEP_FILE_DAYS` (default 30) after it arrives and is then deleted; the report carries the date (`file_kept_until`) and the screens show it. A list whose columns are still unanswered when its file goes is cancelled. Files of cancelled and failed imports are removed at once.

Tidying, as the rows are loaded: phone numbers are checked (made-up numbers and, for ten-digit North American numbers, area codes that do not exist are left out; the plan comes from Google's libphonenumber, `IMPORT_PHONE_REGION`, default US). A lead gets the best phone to call (a mobile before a landline before VoIP, read from headings like "Owner MOBILE 1") and keeps every owner, phone and email beside it in `contacts`. A name cell that holds two owners ("John & Mary Smith") is two owners of one lead.

Repeats: a lead is an owner and a property. The same name with the same phone, email or address is a repeat unless the rows are for different properties; names that are nearly the same on the same phone, email or address are asked about; street words and directions ("Street"/"St", "North"/"N") do not make two addresses. The address key is worked out in the worker (`address_key`) and in the database (`importing.addr_key`), and a test holds the two together.

`tools/bench.py` times an import from file to "ready", for a made-up list of N rows or a real file.

Run `python -m unittest discover -s tests` after installing `requirements.lock` (the exact versions the image uses; `requirements.txt` holds the allowed ranges); database integration tests require a disposable PostgreSQL configured through `CRM_TEST_ADMIN_URL`.
