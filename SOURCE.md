# Where this code came from

The Python here is a copy of part of DataForge, taken on 8 October 2026 from the working tree at `X:\DataForge` (last commit `b576375`, with uncommitted changes on top). Caller Whale runs this copy and does not call into the DataForge folder.

Only what Caller Whale has was copied: projects, lists (import, list, rows) and Skip Tracing.

| Here | From DataForge | Changed |
| --- | --- | --- |
| `callerwhale_service/contracts.py` | `services/application/src/dataforge_application/` | No |
| `callerwhale_service/storage.py`, `jobs.py` | same folder | Cut down: the scrape-run records, pausing, resuming and retrying a job, and the fixture job are not here, because nothing in Caller Whale asks for them |
| `callerwhale_service/datasets.py` | same folder | An import leaves out empty rows and empty columns and reports how many; rows read for the screen carry a reference instead of a picture written into a cell; delimited text and Windows-1252 files import; deleting a list removes its stored files once nothing needs them (marked `# Caller Whale:`). The staged-rows registration, column profiles and the sensitive-roles list are not here |
| `callerwhale_service/skiptrace.py` | same folder | Only the import of the matching package's name |
| `callerwhale_service/cleaning.py` | same folder | Cut down to the two readers Skip Tracing uses (a list's rows, and what its columns are); the clean-up scan and job are not here |
| `callerwhale_service/projects.py`, `logs.py` | same folder | App data folder is `Caller Whale`; environment variables are `CALLERWHALE_APP_DATA`, `CALLERWHALE_LOG_FILE`, `CALLERWHALE_LOG_LEVEL`; two messages; an opened project reports the folder it was opened from, so a copied or moved project is remembered where it now is (marked `# Caller Whale:`) |
| `callerwhale_service/api.py`, `server.py` | same folder | Rewritten shorter: only the project, dataset, job and skiptrace commands, over stdin/stdout only |
| `callerwhale_service/geo.py`, `callerwhale_service/data/zip_centres.csv`, `tools/build_zip_centres.py` | Caller Whale's own, not a copy | Places rows on the map: ZIP centres from two public US Census Bureau files, exact addresses through the Bureau's geocoder |
| `callerwhale_service/area.py` | Caller Whale's own, not a copy | A property's Census tract (geocoder, no key) and its American Community Survey figures (with the person's free key), cached in app data |
| `callerwhale_service/dnc_registry.py` | Caller Whale's own, not a copy | The National Do Not Call Registry from the person's download, kept in app data and asked by every phone check |
| `callerwhale_service/emails.py`, `callerwhale_service/data/disposable_domains.txt` | Caller Whale's own; the domain list is from disposable-email-domains (CC0) | Email verdicts: syntax, likely typos, throwaway domains, shared boxes, and whether the domain takes mail (DNS, cached in app data) |
| `callerwhale_service/images.py` | Caller Whale's own, not a copy | Pictures written into cells are saved in the project's `artifacts/images`; the free USGS aerial view of a place, kept in app data |
| `callerwhale_service/tidy.py` | Caller Whale's own, not a copy | Takes empty rows and columns out of imported lists already in a project, when the project is opened |
| `callerwhale_matching/phone.py`, `cleanup.py` | `workers/matching/src/dataforge_matching/` | No |
| `callerwhale_matching/engine.py`, `normalize.py`, `likelihood.py` | same folder, taken on 13 October 2026 from the working tree (`normalize.py` with its uncommitted changes) | No. Caller Whale calls the engine's candidate groups, field evidence, decisions, grouping and likelihood; its request format, canonical records and survivor rules are here unused |
| `callerwhale_matching/combine.py`, `callerwhale_service/combine.py` | Caller Whale's own, not a copy | Several lists made into one with each lead once, whatever their columns are called; the person's decisions that two rows are, or are not, the same lead, kept in DataForge's `match_constraints` table (unchanged schema) |
| `callerwhale_service/sameness.py` | Caller Whale's own, not a copy | Whether a file being added holds the rows of a list already in the project, by the values of its rows; each list's sketch is kept in `project_settings` |
| `callerwhale_matching/duplicates.py` | Caller Whale's own, not a copy | Rows of one list that repeat the same lead, found during a phone check with the Skip Tracing setup: what the engine decides, read for lists of leads (one owner with several properties, names as county rolls write them, different phones for one lead, office lines), and which row to keep |
| `callerwhale_matching/skiptrace.py` | same folder | Call statuses are read by `status_meaning.py` instead of four word lists; the status table says whether each meaning is sure; a disconnected line counts as a bad number when the warning signs are measured (`SKIPTRACE_VERSION` 5); the setup suggestion reads only status-like columns to the end of the list, with the same result |
| `callerwhale_matching/status_meaning.py`, `callerwhale_service/status_model.py`, `tools/fetch_status_model.py` | Caller Whale's own, not a copy | How call statuses are read: the project's remembered decisions, phrase rules, and an optional local embedding model |
| `database_setup/` | `database_setup/` | No |

Not copied: scraping, the collector extension, Clean & Combine's screens and service (mapping confirmation, the review queue, merged records and exports; only its matching engine is here), public records, automation, workbook export, updates.

`cleaning.py` and `callerwhale_matching/cleanup.py` are here because Skip Tracing uses a few of their helpers. Caller Whale has no clean-up screen. The rule files in `callerwhale_matching/` are kept whole, unused parts included, so they can be copied again from DataForge; the service files above were cut down to what Caller Whale calls, so take DataForge's fixes to those by hand.

## Staying compatible

A project is the same folder and database (`dataforge.sqlite3`, the same database updates) as in DataForge, so a DataForge project opens in Caller Whale. That holds while both have the same database updates. If DataForge adds one, copy it here before opening a project DataForge has already upgraded.

Fixes to the Skip Tracing rules in DataForge do not arrive here by themselves. To take them, copy the unchanged files again; `callerwhale_matching/skiptrace.py` has Caller Whale changes (above) to keep.

Remembered status decisions are kept in the project's `project_settings` table under `skiptrace.status_meanings`, an existing table, so no database update was added.
