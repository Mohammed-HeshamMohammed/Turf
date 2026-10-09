# Turf

The place to manage your lists and the areas they cover.

Start with [PLAN.md](PLAN.md). The mockup that started the idea is in `reference/` (only its look is a reference: revenue, appointments, messages and agent names are not part of Turf).

## How it is built

The same stack as DataForge. Everything Turf runs is in this repository; it does not call into the DataForge folder.

| Part | Technology | What it does |
| --- | --- | --- |
| Window | React + TypeScript (`src/`) | The three tabs: Dashboard, Lists, Skip Tracing. It never touches files or the database itself. |
| Host | Rust + Tauri 2 (`src-tauri/`) | The desktop window with its own title bar. Starts the service, forwards commands to it, and keeps what Turf itself saves. |
| Service | Python (`service/`) | Projects, lists and Skip Tracing, in a project folder (SQLite). Copied from DataForge; see [service/SOURCE.md](service/SOURCE.md). |

A project is the same folder format as DataForge's, so a DataForge project opens in Turf.

## Run it

Needs Node.js, Rust, and Python 3.11+ (`TURF_PYTHON` picks which one) with the service's packages:

```bash
pip install -r service/requirements.txt
```

As the desktop app (the first run compiles for a few minutes):

```bash
npm install
npm run desktop
```

In a browser tab, for working on the screens:

```bash
npm run dev
```

Then open http://localhost:5183. The dev server talks to the service the same way the host does.

## Check it

```bash
npm run check
```

Runs the type check and build of the window, the service's tests (pytest) and the host's tests (cargo).

## What is here

| Path | What it is |
| --- | --- |
| `src/tabs/Dashboard.tsx` | Totals, phone verdicts, newest listings, the lists and their areas. |
| `src/tabs/Lists.tsx` | The list picker, a list's rows with their marks, its areas and map, filters and search. |
| `src/tabs/SkipTracing.tsx` | The same flow as DataForge's Skip Tracing tab: phone columns, call outcomes, warning signs, the check and its results, and saving the checked copy. |
| `src/components/ProjectGate.tsx` | Opening or creating a project. |
| `src/components/TitleBar.tsx` | The window's own title bar, after Virtual Tracker's. Its buttons show only in the desktop window. |
| `src/lib/service.ts` | The window's side of the service: one function per command. |
| `src/lib/marks.ts` | Reads marks and areas from a list's columns. |
| `src-tauri/src/sidecar.rs` | The bridge to the service: a child process speaking JSON lines, as in DataForge's host. |
| `src-tauri/src/store.rs` | What Turf itself keeps (marks made by hand, the area columns picked for a list), in `turf.json` in the app's data folder. |
| `service/turf_service/` | The service: the command router, projects, lists, jobs and the Skip Tracing commands. An import leaves out empty rows and columns; lists already in a project get the same when it is opened (`tidy.py`). |
| `service/turf_matching/` | Phone reading and the Skip Tracing rules. |
| `service/turf_service/geo.py` | Where rows go on the map: the centre of their ZIP (a file shipped with Turf, checked against the row's state), or their exact address when the person asks for the lookup. The lookup sends street, city, state and ZIP to the US Census Bureau's geocoder; nothing else leaves the computer. |
| `service/migrations/` | The project database's schema. |
| `vite.config.ts` | For a browser tab only: serves `/rpc` over the same bridge. |

## Not done yet

- **Marks made by hand are not read by the phone check.** They show on rows only. Feeding them in as call outcomes is the next step for the service.
- **No installer.** A packaged Turf would ship the service built into one executable (`service/turf-service.exe`); the host already looks for it there. Until then Turf runs from source and needs Python.
- **Listings come from DataForge.** Turf has no collector; a collected run shows in Turf when its project is opened here.
- **Turf and DataForge open at once on one project** has not been tested. Opening a project recovers interrupted jobs, so do not open a project in Turf while DataForge is running a job on it.
- **The street map needs the internet the first time.** Its background comes from OpenFreeMap (OpenStreetMap data, free, no key) and ZIP outlines from the US Census Bureau; only map addresses and ZIP codes are asked for, never a row. The desktop host keeps every piece on disk (`src-tauri/src/mapcache.rs`, and the service's outline folder), so what was looked at before draws without a connection. Parts never looked at do not, and the cache has no size limit yet.
