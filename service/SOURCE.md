# Where this code came from

The Python here is a copy of part of DataForge, taken on 8 October 2026 from the working tree at `X:\DataForge` (last commit `b576375`, with uncommitted changes on top). Turf runs this copy and does not call into the DataForge folder.

Only what Turf has was copied: projects, lists (import, list, rows) and Skip Tracing.

| Here | From DataForge | Changed |
| --- | --- | --- |
| `turf_service/storage.py`, `jobs.py`, `contracts.py` | `services/application/src/dataforge_application/` | No |
| `turf_service/datasets.py` | same folder | An import leaves out empty rows and empty columns and reports how many; rows read for the screen carry a reference instead of a picture written into a cell (marked `# Turf:`) |
| `turf_service/cleaning.py`, `skiptrace.py` | same folder | Only the import of the matching package's name |
| `turf_service/projects.py`, `logs.py` | same folder | App data folder is `Turf`; environment variables are `TURF_APP_DATA`, `TURF_LOG_FILE`, `TURF_LOG_LEVEL`; two messages; an opened project reports the folder it was opened from, so a copied or moved project is remembered where it now is (marked `# Turf:`) |
| `turf_service/api.py`, `server.py` | same folder | Rewritten shorter: only the project, dataset, job and skiptrace commands, over stdin/stdout only |
| `turf_service/geo.py`, `turf_service/data/zip_centres.csv`, `tools/build_zip_centres.py` | Turf's own, not a copy | Places rows on the map: ZIP centres from two public US Census Bureau files, exact addresses through the Bureau's geocoder |
| `turf_service/dnc_registry.py` | Turf's own, not a copy | The National Do Not Call Registry from the person's download, kept in app data and asked by every phone check |
| `turf_service/images.py` | Turf's own, not a copy | Pictures written into cells are saved in the project's `artifacts/images`; the free USGS aerial view of a place, kept in app data |
| `turf_service/tidy.py` | Turf's own, not a copy | Takes empty rows and columns out of imported lists already in a project, when the project is opened |
| `turf_matching/phone.py`, `cleanup.py` | `workers/matching/src/dataforge_matching/` | No |
| `turf_matching/skiptrace.py` | same folder | Call statuses are read by `status_meaning.py` instead of four word lists; the status table says whether each meaning is sure; a disconnected line counts as a bad number when the warning signs are measured (`SKIPTRACE_VERSION` 5) |
| `turf_matching/status_meaning.py`, `turf_service/status_model.py`, `tools/fetch_status_model.py` | Turf's own, not a copy | How call statuses are read: the project's remembered decisions, phrase rules, and an optional local embedding model |
| `migrations/` | `migrations/` | No |

Not copied: scraping, the collector extension, Clean & Combine (matching, review, exports), public records, automation, workbook export, updates.

`cleaning.py` and `turf_matching/cleanup.py` are here because Skip Tracing uses a few of their helpers. Turf has no clean-up screen.

## Staying compatible

A project is the same folder and database (`dataforge.sqlite3`, the same migrations) as in DataForge, so a DataForge project opens in Turf. That holds while both have the same migrations. If DataForge adds one, copy it here before opening a project DataForge has already upgraded.

Fixes to the Skip Tracing rules in DataForge do not arrive here by themselves. To take them, copy the unchanged files again; `turf_matching/skiptrace.py` has Turf changes (above) to keep.

Remembered status decisions are kept in the project's `project_settings` table under `skiptrace.status_meanings`, an existing table, so no migration was added.
