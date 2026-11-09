# Importing and data storing: review and plan (2026-11-10)

Scope: the import service (`services/features/importing-lists`: upload API, worker, readers, matching) and how imported data is stored (the `importing` schema and the merge into leads). Not the CRM screens, not the rest of crm-core.

What is already right: size limits, a zip-bomb guard, XML entity tricks refused, SHA-256 per piece with resume, one login for the worker that cannot touch leads, non-root user, abandoned uploads cleared after 48 hours, failed rows cleared after 14 days, 3 active imports per workspace.

## A. Failure risks (done 2026-11-10)

1. **A dead worker looks healthy.** The worker is a thread in the web server; its loop catches only database errors, and `/healthz` answers "ok" whatever the thread is doing. Fix: catch every error in the loop (log it, wait, carry on), and make `/healthz` fail when the worker thread is gone or has not looped for a minute.
2. **A bad file can crash-loop the service.** Memory is deliberately uncapped, so a file that runs the container out of memory is claimed again after the two-minute stale timer, for ever. Fix: count attempts on the job; after 3 claims mark it failed with the plain message.
3. **Slow connections can use up the database.** `chunk()` holds a database connection for the whole transfer of a piece, and the HTTP server has no socket timeout. Fix: a 60-second socket timeout on the handler, and read the piece to disk before taking the connection.
4. **Nothing protects the disk.** Default maximum 20 GB per file, 3 imports per workspace, no free-space check. Fix: refuse an upload when free space is under about 3 times its size (upload, assembled file, UTF-8 copy), and cap the bytes in flight per workspace.

## B. Next

Done: 7 (lock file `requirements.lock`, used by the Dockerfile), 9 (tests for the poison file, the dead worker, the full disk and the stalled sender). Still open: 5, 6 (need Coolify and a decision), 8, 10.

5. **Two containers from one image:** the upload API and the worker apart, so an out-of-memory crash of the worker does not stop uploads.
6. **Fairness:** today one import loads or cleans at a time for the whole platform. Allow one per workspace (or a second worker), still one heavy job per workspace.
7. **Repeatable builds:** a lock file for the Python packages (versions are ranges now), base images pinned by digest.
8. **`importRows` paging:** keyset instead of `OFFSET` so deep pages of a 500,000-row list stay quick (crm-core, imports only).
9. **Tests for the failures above:** a poison file, the worker thread dying, a full disk, a stalled upload.
10. **Check how crm-core's import requests handle database timeouts and cancellation** (not reviewed yet).

## C. To decide

- **How long completed imports keep their raw source rows** (phones, addresses). Today they are kept for ever; failed and cancelled ones are cleared after 14 days. Proposal to discuss: keep completed ones for 30 days, then keep only the counts and the report.
- **Formula safety in exports** (cells starting with `=`, `+`, `-`, `@`) when exports of imported data exist.
- **Server disk alert** in Coolify, or a separate disk for the imports volume.

## D. Learning store (built 2026-11-10, switched off; see learning-store-compliance.md)

Built: `services/learning` with its own database, crm-core copies a finished import to it (off until `LEARNING_URL` is set), the holding rows lose their personal details a week later, opt-out and erasure routes. NOT built, on purpose: the encrypted readable copy (tier 2) until a lawyer agrees. The text below is the original proposal.

The owner's wishes: imported data is not deleted by the system (only when the customer deletes it); the system learns from it, so it moves out of the working database into a separate store; what it learns is how leads were handled (the flags callers and users give), column mapping, data quality rules and models for early feedback on new leads; everything stored is masked and hashed; only the platform owners can read it back; when a customer deletes, only a derived copy that helps suggestions stays, not the full data.

Open point: "hashed" and "decrypted by the owners" are different things. A hash cannot be turned back; encryption can. Proposed design that keeps both wishes:

- **A separate PostgreSQL database `learning`** in its own container with its own login. Neither crm-core nor the importing worker can read it; the worker may only add to it. Backed up apart.
- **Tier 1, always kept (learned copy):** per imported lead a keyed hash (HMAC with a secret only the platform owners hold) of phone and email, the shape of the name and address (street number removed; city, state, ZIP kept), field completeness, the property details, which list and which column mapping, and later the flags: stage, verdict, call outcomes, do-not-call. No real phone, email or street address. This is what suggestions and models learn from; nothing has to be decrypted.
- **Tier 2, only if wanted (readable by owners):** the raw row encrypted with a key held only by the platform owners. It is deleted when the customer deletes the list, the lead or the workspace; tier 1 stays.
- **Moving:** when an import is merged, its holding rows are copied to the learning store, then deleted from the working database after a short grace period (so a failed copy can be retried). The working database keeps the leads and the import report only.
- **Customer deletes:** tier 2 goes, tier 1 stays (as the owner asked), and the customer's copy in the working database goes.

Risk to settle before launch (not legal advice): the leads are other people's personal details (phone, address). Keeping even hashed copies for our own learning makes Caller Whale more than a processor for them. The terms and privacy notice must say so, say what is kept after deletion and for what, and a customer must be able to ask for the learned copy to be removed (tier 1 rows carry a workspace id so they can be). A lawyer should read the terms before this ships.

## Order

A1 to A4 together (one change, one test each), then B5 and B6, then B7 to B10, then the decisions in C.

## What was built for A

1. `run_forever` catches every error and carries on; `/healthz` answers 503 when the worker thread is gone.
2. `importing.jobs.attempts` (crm-core migration 0008): a job picked up again after its worker stopped is failed on the third stop.
3. The handler has a 60-second socket timeout, and a piece is read to disk before any database connection is taken.
4. `start` refuses a list when free disk is under 3 times its size plus 1 GB (507), and when the workspace's lists in flight exceed `MAX_ORG_ACTIVE_MB` (default 30720); a full disk while a piece arrives answers 507, not a crash.

## Working notes

- The uploaded file is deleted from the server's disk as soon as its rows are in the database (`load()`, and a sweep every minute): already true, so the free-space check only has to cover the upload and loading.

- The owner has given Claude access to Coolify and callerwhale.com in the browser; Coolify changes (a second container, volumes, alerts) can be made there once agreed.
