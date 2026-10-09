# Where this code came from

The Python here is a copy of part of DataForge, taken on 8 October 2026 from the working tree at `X:\DataForge` (last commit `b576375`, with uncommitted changes on top). Turf runs this copy and does not call into the DataForge folder.

Only what Turf has was copied: projects, lists (import, list, rows) and Skip Tracing.

| Here | From DataForge | Changed |
| --- | --- | --- |
| `turf_service/storage.py`, `jobs.py`, `contracts.py` | `services/application/src/dataforge_application/` | No |
| `turf_service/datasets.py` | same folder | An import leaves out empty rows and empty columns and reports how many (marked `# Turf:`) |
| `turf_service/cleaning.py`, `skiptrace.py` | same folder | Only the import of the matching package's name |
| `turf_service/projects.py`, `logs.py` | same folder | App data folder is `Turf`; environment variables are `TURF_APP_DATA`, `TURF_LOG_FILE`, `TURF_LOG_LEVEL`; two messages; an opened project reports the folder it was opened from, so a copied or moved project is remembered where it now is (marked `# Turf:`) |
| `turf_service/api.py`, `server.py` | same folder | Rewritten shorter: only the project, dataset, job and skiptrace commands, over stdin/stdout only |
| `turf_service/geo.py`, `turf_service/data/zip_centres.csv`, `tools/build_zip_centres.py` | Turf's own, not a copy | Places rows on the map: ZIP centres from two public US Census Bureau files, exact addresses through the Bureau's geocoder |
| `turf_service/tidy.py` | Turf's own, not a copy | Takes empty rows and columns out of imported lists already in a project, when the project is opened |
| `turf_matching/phone.py`, `cleanup.py`, `skiptrace.py` | `workers/matching/src/dataforge_matching/` | No |
| `migrations/` | `migrations/` | No |

Not copied: scraping, the collector extension, Clean & Combine (matching, review, exports), public records, automation, workbook export, updates.

`cleaning.py` and `turf_matching/cleanup.py` are here because Skip Tracing uses a few of their helpers. Turf has no clean-up screen.

## Staying compatible

A project is the same folder and database (`dataforge.sqlite3`, the same migrations) as in DataForge, so a DataForge project opens in Turf. That holds while both have the same migrations. If DataForge adds one, copy it here before opening a project DataForge has already upgraded.

Fixes to the Skip Tracing rules in DataForge do not arrive here by themselves. To take them, copy the unchanged files again.
