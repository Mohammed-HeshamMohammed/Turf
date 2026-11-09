# Importing and data storing: review and plan (2026-11-10)

Scope: the import service (`services/features/importing-lists`: upload API, worker, readers, matching) and how imported data is stored (the `importing` schema and the merge into leads). Not the CRM screens, not the rest of crm-core.

What is already right: size limits, a zip-bomb guard, XML entity tricks refused, SHA-256 per piece with resume, one login for the worker that cannot touch leads, non-root user, abandoned uploads cleared after 48 hours, failed rows cleared after 14 days, 3 active imports per workspace.

## A. Failure risks (do first, each is small)

1. **A dead worker looks healthy.** The worker is a thread in the web server; its loop catches only database errors, and `/healthz` answers "ok" whatever the thread is doing. Fix: catch every error in the loop (log it, wait, carry on), and make `/healthz` fail when the worker thread is gone or has not looped for a minute.
2. **A bad file can crash-loop the service.** Memory is deliberately uncapped, so a file that runs the container out of memory is claimed again after the two-minute stale timer, for ever. Fix: count attempts on the job; after 3 claims mark it failed with the plain message.
3. **Slow connections can use up the database.** `chunk()` holds a database connection for the whole transfer of a piece, and the HTTP server has no socket timeout. Fix: a 60-second socket timeout on the handler, and read the piece to disk before taking the connection.
4. **Nothing protects the disk.** Default maximum 20 GB per file, 3 imports per workspace, no free-space check. Fix: refuse an upload when free space is under about 3 times its size (upload, assembled file, UTF-8 copy), and cap the bytes in flight per workspace.

## B. Next

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

## Order

A1 to A4 together (one change, one test each), then B5 and B6, then B7 to B10, then the decisions in C.

## Working notes

- The owner has given Claude access to Coolify and callerwhale.com in the browser; Coolify changes (a second container, volumes, alerts) can be made there once agreed.
