# Importing lists: data quality and speed

**Status:** Built (2026-11-10), apart from the items listed at the end of this paragraph. Built: the columns are asked about first and only the kept ones are loaded, tidied, in one write; relatives' columns are left out; the uploaded file is kept 30 days, then deleted, and the person is told the date; phones are checked with libphonenumber's plan (made-up numbers and area codes that do not exist are left out), the lead gets the best phone to call (mobile, then landline, then VoIP, read from the headings) and keeps every owner, phone and email in `contacts`, shown on the lead page; a name cell with two owners is two owners of one lead; a lead is an owner and a property (the same owner with another property is not a repeat), street words and directions do not split one address, and names that are nearly the same on one phone, email or address are asked about; the fingerprint is computed in the insert and the table is analyzed after the load; the comparison is skipped when the account has no leads; the rows behind each count of the cleaning report can be listed and downloaded; a template file; "choose the columns again" (the kept file is read again); the workspace screen shows the first leads at once and the rest as pages arrive. A timing tool is `services/features/importing-lists/tools/bench.py`. Not built: reading phone numbers from a carrier lookup (the slot is `linetype.py`; without one, line types come from the headings), parsing names with probablepeople (joint names are split on "&" and "and" only), `libpostal`, and the one-statement comparison with existing leads (B3), which was not needed to reach the target.

What follows is the plan as written before that work. It follows the work already in `main` (reader fixes, cleaning report, same-person questions, merge log, preview, column memory, parallel tidying).

Two parts: **A** brings the tidying and matching up to published practice; **B** makes a 1,000,000-row list fast. B changes how rows are written, so do B before the parts of A that touch the same statements (A1, A3, A4).

Code: `services/features/importing-lists` (Python worker), `services/crm-core/imports.go` (Go), `apps/crm/src/ServerImport.jsx` (screens).

---

## Decisions (2026-11-10)

1. **The database stays PostgreSQL.** The slowness is in how the importer uses it. MySQL and MariaDB are the same kind of database (no gain, a full rewrite); Redis, KeyDB and Dragonfly are caches and queues; MongoDB is weaker at the joins repeat-matching needs; SQLite has one writer; ClickHouse is for analytics, is poor at updates and removes duplicates in the background at times nobody controls. ClickHouse may be added later beside PostgreSQL for reporting over calls; it is not an import fix.
2. **Relatives' columns are ignored.** Skip-traced lists carry phones and names for up to 20 relatives of the owner; that data is often wrong and is not the lead. Columns whose heading starts with "Relative N" are left out while the file is read: not stored, not offered at the column step, listed in the report as left out. An owner with no phone stays without one; a relative's number is never used in its place.

## What a real list showed (2026-11-10)

One skip-traced property list: 482,887 rows, **407 columns**, 520 MB. The synthetic lists used for the measurements in Part B have 5 columns, so they hide what follows.

| Step | Seconds |
| --- | --- |
| Load | 815 |
| Clean (tidy 74, merge identical rows 25, repeats inside the list 19, compare with existing leads 205, the rest 33) | 356 |
| **Total** | **about 1,170 (19.5 minutes)**, worker memory 1.35 GB |

Profile of the load on the first 50,000 rows (114.5 seconds):

| Part | Seconds | Share |
| --- | --- | --- |
| Counting which columns are empty (`column_population`) | 56.7 | 50% |
| Rewriting every row to drop the empty columns (`drop_empty_columns`) | 48.1 | 42% |
| Reading the file and storing the rows | 9.6 | 8% |

Why: a row's cells are one `text[]`, and the SQL reaches into it by position once per column (`cells[1]` ... `cells[407]`). Finding element N of a text array means walking the N-1 before it, so the work per row grows with the square of the number of columns. 10 empty columns of 407 were removed at the cost of 92% of the load.

Also seen:

- **The comparison with existing leads took 205 seconds with no leads in the account.** It runs, and re-reads the wide rows five times per range, even when there is nothing to compare with.
- **Only 41 of about 240 phone columns were recognised**, by what their cells look like and not by headings such as `Owner MOBILE 1`. With decision 2 the relatives' ones no longer matter; the owner's (`Owner MOBILE 1..5`, `Owner LANDLINE 1..5`, `Owner VOIP 1..5`, `Owner PAGER 1..2`) must be recognised by heading.
- **The headings carry the line type.** MOBILE, LANDLINE, VOIP and PAGER are in the column names: for lists like this the line type needs no lookup at all.
- **4,839 rows in 2,400 groups were sent to review as possible repeats.** Not inspected row by row; the likely cause is one owner with several properties, the same name and phone on different addresses. In a property list those are separate leads.

What this adds to the plan:

- **B0 (new, first).** Leave relatives' and empty columns out while reading; count filled cells per column in polars as the batches pass; never rewrite stored rows to remove a column, and never reach into `cells` by position for every column in SQL. Expected: load from about 815 seconds to about 100. Changing how columns are numbered touches every reader of `cells` (`SourceRows.jsx`, the merge in `imports.go`, the learning copy): check each.
- **B3 (changed).** Skip the comparison when the account has no leads, and read each range of rows once, not five times.
- **A1 (added to).** Read the line type from the heading when it says MOBILE, LANDLINE, VOIP or PAGER; keep every owner phone with its type instead of the first one only. Needs a place to store more than one phone per lead: a product decision.
- **A8 (new).** A lead is an owner and a property. Two rows with the same owner and phone but different property addresses are not repeats: the property address becomes part of what makes a repeat. Confirm on the real list before changing the rule.
- **Search formulas for A4**, all built into PostgreSQL: trigram similarity (`pg_trgm`, indexable, default threshold 0.3, to be tuned), Levenshtein distance for "within two edits", and phonetic codes (Daitch-Mokotoff rather than Soundex, which is weak outside English names). Always in two stages: find candidates by an exact key (same phone, email or address), then score the names.

The target in Part B (under 60 seconds for 1,000,000 narrow rows) stands; add a second one: **the 482,887-row, 407-column list under 3 minutes from file to "ready to add"**.

---

## Part A: data quality

Ordered by value. Each item says what "done" is.

### A1. Phone numbers with libphonenumber

- **Now:** `importing.norm_phone` keeps the digits (7 to 15 of them) and a hand-written rule drops repeated digits and runs like 1234567890.
- **Change:** validate with the `phonenumbers` package (the Python port of Google's libphonenumber): valid for its country or not, stored as E.164, and its type (mobile, fixed line, toll-free, VoIP).
- **Decisions needed:** the default country for numbers written without a country code (per workspace, default US). Whether stored phones change to E.164 everywhere (leads, matching view, dialer) or only the match key does. Changing the stored form touches `importing.norm_phone`, the `lead_match` view and `call_import.go`.
- **Line type:** `number_type()` answers mobile or landline for many countries with no outside service. In the US and Canada mobile and fixed lines share number ranges, so it often answers "fixed line or mobile": a real carrier lookup is still needed there. Register it as the first provider in `linetype.py` and keep the slot for a carrier lookup.
- **Done when:** an invalid number is reported as invalid with its reason, the cleaning report counts by reason, and the line-type counts appear without any outside service where the library can tell.

### A2. ANALYZE after loading and after tidying

- **Now:** never run. A freshly loaded table has no statistics, and PostgreSQL then planned the lead comparison as a row-by-row self-join that took minutes. The query was rewritten to survive that, but every other statement still plans blind.
- **Change:** `ANALYZE importing.rows` once the load ends and once the tidying ends.
- **To check first:** `ANALYZE` needs the table's owner (or the MAINTAIN privilege on PostgreSQL 17). The worker's login is not the owner. Either grant MAINTAIN in `db.go` beside the other grants, or have crm-core run it.
- **Done when:** the statements of Part B plan with hash joins on a new list, checked with `EXPLAIN`.

### A3. Addresses standardised before matching

- **Now:** `importing.addr_key` strips everything but letters and digits and adds the ZIP. "123 Main Street" and "123 Main St" are two addresses.
- **Change:** build the match key from parsed parts: house number, street name, a standard street type (Street to ST, Avenue to AVE: the USPS suffix list), a standard direction (North to N), unit, ZIP. Parse with `usaddress` (US). The stored address is not changed: only the key.
- **Limits:** `usaddress` is US only and says itself it is not perfectly accurate; a row it cannot parse keeps today's key. International lists would need `libpostal`, which is a large C library with a 2 GB model: not planned.
- **Cost:** the key is computed in SQL today, for the leads as well (the `lead_match` view). A Python parser cannot run inside that view, so the key becomes a stored column on properties and on holding rows, filled by the worker and by crm-core when an address changes. This is the expensive part of the item.
- **Done when:** two rows that differ only in "St" and "Street", or "N" and "North", are found as repeats, and a test list of real addresses shows no new wrong matches.

### A4. Names that are nearly the same are asked about

- **Now:** names match only when they are equal after removing case, spaces and punctuation. "Jon Smith" and "John Smith" on the same phone are two people, silently.
- **Change:** when a phone, an email or an address is the same and the names are close (PostgreSQL's `pg_trgm` similarity above a threshold, to be tuned on real lists), put the pair to the person as "is this the same person?". Never merged without asking, the same rule as phone-only matches.
- **Not using:** Splink or Dedupe. They are built for probabilistic linking of millions of records with trained weights; this needs one similarity test beside keys that already match.
- **Done when:** near names on a shared key appear in the repeat review, and exact-name behaviour is unchanged.

### A5. Names parsed properly

- **Now:** a regular expression turns "SMITH, JOHN" around and fixes capitals.
- **Change:** `probablepeople` splits a name into given name, surname, suffix, and tells a person from a company; "John & Mary Smith" becomes two owners.
- **Open question:** what a second owner becomes in the CRM (a second lead, or an owner field on the same lead). That is a product decision, not a parsing one.
- **Done when:** the cases in the existing name test still pass and joint owners are handled as decided.

### A6. The rows behind each count

- **Now:** the report says "212 emails were not valid" but not which.
- **Change:** an endpoint that lists the rows behind a count (row number, the column, the value, the reason), and a download as CSV. Published guidance for import screens is consistent on this: show the exact row and column, and say how to fix it.
- **Done when:** every count in the cleaning report opens its rows.

### A7. A template file

- A downloadable CSV with the headings Caller Whale recognises, linked from the upload step. Screen work only.

---

## Part B: a 1,000,000-row list, fast

### Where the time goes today

Measured on a laptop with a default-configured local PostgreSQL, 1,000,000 rows against 250,000 existing leads, four tidying connections:

| Step | Seconds |
| --- | --- |
| Load (read the file, store the rows) | 29 |
| Tidy (four connections) | 40 |
| Merge rows that are identical | 8 |
| Find repeats inside the list | 32 |
| Read the existing leads' keys | 7 |
| Compare with the existing leads | 50 |
| Everything else in the cleaning step | 8 |
| **Total, not counting adding the leads** | **about 175** |

Adding the leads (crm-core's merge) was not measured. Memory in the worker peaked at 508 MB.

For scale: published tests put a plain `COPY` of 1,000,000 rows into PostgreSQL at 1.3 to 4.3 seconds. The file is not the slow part. The slow part is that every row is written three or four times and that the comparisons are done in hundreds of small statements.

### What is wrong with the shape

1. **Each row is written several times.** `COPY` into a temporary table, an `UPDATE` there to add the fingerprint, an `INSERT` into `importing.rows`, then a second `UPDATE` of every row with its tidied values, then more `UPDATE`s for its state. In PostgreSQL an `UPDATE` writes a whole new copy of the row and leaves the old one for VACUUM. The tidying `UPDATE` also changes `state`, which is indexed, so every index on the table is written again for every row. Published advice for large tables is the same everywhere: write the row once in its final form instead of updating it.
2. **The comparison with existing leads runs 200 statements of 5,000 rows.** That was done to move a progress bar. With statistics (A2) one statement with hash joins does the same work.
3. **Finding repeats inside the list sorts the whole list three times** (once per key) and then brings the candidates into Python to group them.

### The changes, in order

**B1. Compute the fingerprint in the insert, not in a separate update.** `INSERT ... SELECT row_no, sha256(...), cells FROM _stage` instead of `UPDATE _stage SET fp = ...` then insert. One pass less over every row. Small and safe.

**B2. ANALYZE (A2).** Needed by B3 and B4.

**B3. One statement for the comparison with existing leads.** The five joins over the whole list at once, hash-joined to the lead keys, written into a temporary table of (row, lead, hits). Progress is then shown per join (five steps) instead of per 5,000 rows. Expected: 50 seconds down to under 10. Check with `EXPLAIN` that the plan is a hash join; keep the ranged form as the fallback if the planner refuses.

**B4. Repeats inside the list with hash aggregates.** Count each key once (`GROUP BY phone HAVING count(*) > 1`, and the same for email and address) and pick the rows by those keys, instead of three window sorts. A first attempt at this showed no gain, but it ran before the statistics problem was found, so it must be measured again after B2. Expected: 32 seconds down to about 10.

**B5. Write the tidied row once.** The largest change, and the one that needs care:

- The load writes the raw rows to `importing.rows_raw` (job, row number, fingerprint, cells): what `importing.rows` holds today before the tidying.
- The tidying is `INSERT INTO importing.rows SELECT ... FROM importing.rows_raw`, with every tidied value and the state already set. No `UPDATE` of a million rows, no dead rows, indexes written once.
- The source-rows screen and the column step read `rows_raw` until the tidying ends, then `rows`.
- Touches: `worker.py` (load, clean), `imports.go` (`importRows`, the merge), `SourceRows.jsx`, a migration, the learning copy, and the sweeps that delete old rows.
- Expected: the 40 seconds of tidying down to about 15, and less work for VACUUM afterwards.
- Risk: this is the table everything reads. Do it behind the existing tests, with a 1,000,000-row run before and after.

**B6. Decide where the tidying runs.** Two honest options once B5 exists:

- *In PostgreSQL*, as now. Simple, one place for the rules, but phone validation (A1), address parsing (A3) and name parsing (A5) are Python libraries and cannot run there.
- *In the worker, before the row is stored*: read the batch, tidy it in polars with the Python libraries, `COPY` the finished rows. This is what A1, A3 and A5 need anyway. The cost is that the column step happens after the load today, so the raw rows must be read back from `rows_raw` for tidying; that is a `COPY ... TO` of the raw rows and a `COPY ... FROM` of the tidied ones, both fast.
- The second option is the likely answer because of Part A. Decide after B5, with a measurement of each on 1,000,000 rows.

**B7. Server settings worth asking for.** Not code: on the database that runs imports, `work_mem` for the import role (already set per statement to 256 MB), `maintenance_work_mem` for index builds, and `max_wal_size` large enough that a load does not force checkpoints. Record what production has before changing anything.

### Not planned

- **Replacing polars.** Reading the file is 29 seconds of 175 and most of that is PostgreSQL storing the rows. DuckDB is about as fast and has a memory limit with spill to disk; it is the option if memory ever becomes the problem, not speed.
- **Unlogged holding tables.** They skip the write-ahead log and load faster, but they are emptied after a crash and are not copied to replicas or backups. A list being reviewed for days should not vanish.
- **Dropping indexes during the load.** The table is shared by every workspace's imports; its indexes cannot be dropped for one of them.

### Target

Under 60 seconds for 1,000,000 rows on the same laptop, from the file arriving to "ready to add", with the same answers as today. Measure after each step; stop when the target is met.

### How to measure

A script that builds a list of N rows with a known share of repeats, runs load and clean through the worker against a local PostgreSQL, and prints seconds per step and peak memory. It lived in a scratch folder during this work; check it into `services/features/importing-lists/tools/bench.py` as the first step of Part B. Run one at a time: a run that is killed leaves its statement running in PostgreSQL, and the next run then measures the leftover.

---

## Sources

- EDB, "7 Best Practice Tips for PostgreSQL Bulk Data Loading": https://enterprisedb.com/blog/7-best-practice-tips-postgresql-bulk-data-loading
- Tiger Data, insert vs batch insert vs COPY: https://www.tigerdata.com/learn/testing-postgres-ingest-insert-vs-batch-insert-vs-copy
- "1M Rows Into Postgres in 1.29 Seconds": https://karan.is-a.dev/blog/postgres-copy-ingest/1m-rows-into-postgres-in-1-29-seconds
- Codacy, "How to update large tables in PostgreSQL": https://blog.codacy.com/how-to-update-large-tables-in-postgresql
- "CTAS and swap: rewriting a large Postgres table without the MVCC tax": https://dev.to/wondadav/ctas-and-swap-rewriting-a-large-postgres-table-without-the-mvcc-tax-14af
- pgsql-performance, "Bulk DML performance": https://www.postgresql.org/message-id/00b001db9418%2485c7c770%2491575650%24%40ymail.com
- phonenumbers: https://pypi.org/project/phonenumbers
- usaddress: https://usaddress.readthedocs.io/en/latest/
- probablepeople: https://pypi.org/project/probablepeople
- Entity resolution at scale (Dedupe's limits, blocking): https://arxiv.org/pdf/2508.03767
- OneSchema, "5 Best Practices for Building a CSV Uploader": https://oneschema.co/blog/building-a-csv-uploader
- Dromo, data mapping for CSV imports: https://dromo.io/blog/data-mapping-best-practices-csv-imports
- Pandas, Polars and DuckDB on a 1.2M-row CSV: https://www.besthub.dev/articles/pandas-vs-polars-vs-duckdb-benchmarking-performance-on-a-1-2m-row-csv-2f0e65581b9d

Most of these are vendor or personal write-ups. The numbers in them are other people's hardware; the table above is ours.

---

## Opening the workspace after a big import (the snapshot)

**What the snapshot is.** The first time a browser opens a workspace, and again whenever its copy cannot be brought up to date, it asks the server for a snapshot: up to 3,000 leads (the person's own first, then the most recently changed) with their tasks, notes, calls, handoffs and deals, the list totals, and a cursor. After that the browser only asks for what changed since the cursor (a pull). A snapshot is therefore the one request that grows with the workspace.

**What went wrong (2026-11-10).** On a workspace with the 482,888-lead import in it, `/sync/snapshot` did not answer within Cloudflare's 100 seconds (error 524, which carries no CORS header, so the browser reported it as a CORS error). Measured with 100,000 leads it took 35 seconds, however few leads were asked for: three statements (the window, the total and the per-list counts) ran the `cw_visible_lead` function once per lead of the whole workspace, and the function runs a query of its own each time. Extrapolated to 500,000 leads that is about three minutes.

**What was changed.**

| Workspace | Before | After |
| --- | --- | --- |
| 100,000 leads | 35 s | 2.4 s |
| 500,000 leads | about 175 s (extrapolated) | 4.5 s |

- The bulk statements use the person's scopes as a condition on the lead row (`leadVisible`) instead of calling the function per lead; a test checks it shows exactly what the function shows for every mix of scopes.
- The window is read as two halves (the person's own leads, then the rest) from a new index `leads_recent` (`org_id, updated_at DESC, id DESC`), each stopping after the first few hundred, instead of sorting every lead.
- The totals and the per-list counts come from one pass, not two.
- `/sync/snapshot?limit=N&after=TOKEN` gives the leads a page at a time; the browser shows the first 250 at once and adds the rest as they arrive.
- A copy kept from the last session is no longer thrown away when its day has passed: the records stay sealed until the server has confirmed the person's access, then only the difference is fetched. The offline permission used to be set once, at the snapshot, and never renewed, so a copy was discarded a day after it was first downloaded however often it was used; every pull now renews it. If the person's access changed, or more than 5,000 changes happened while the browser was away (a big import does that), the records are taken again, which is now quick.

**Still true.** Counting a workspace's leads is one pass over them (about 4 seconds at 500,000); a table of counts kept up to date would remove it. A big import still sends every device back to a full snapshot once, because the change record is not paged past 5,000 entries. The offline copy is only written to the device when the person has set an unlock passphrase (the copy is sealed with a key made from it); without one nothing is kept on disk and every visit starts with a snapshot.

