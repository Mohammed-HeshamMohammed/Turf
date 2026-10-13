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

The frontend service client lives in `src/lib/service/`: `transport.ts` handles browser/native calls, `jobs.ts` watches jobs, and the other modules group project, dataset, Skip Tracing, local-state and enrichment operations. `src/lib/service.ts` remains the shared public entry point. Internal service modules import the transport directly to avoid cycles.

Lists composes `ListRowDetail`, `OwnerPanel`, `EmailWithVerdict` and `MapNote`; table column selection lives in `src/lib/list-columns.tsx`. Skip Tracing delegates readiness and report details to `SkiptraceReadiness` and `SkiptraceReportDetails`, with configuration rules in `src/lib/skiptrace-workflow.ts`. DNC and NANPA share `RegistryFileImport` for loading files while retaining their own coverage and age messages.

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

Runs the type check and build of the window, UI interaction tests (Vitest), the service's tests (pytest), and the host's tests (cargo). For checks that do not need desktop libraries, run `npm run build`, `npm test`, and `python -m pytest service/tests -q`.

## Owners, contacts and areas

Beyond phones, Turf reads what the lists themselves say, for free:

- **Owners.** Each owner name is read as a person, household, company or LLC, trust, estate (the owner may have died), government or bank, by wording rules (`src/lib/owners.ts`). The mailing address shows absentee, out-of-state and PO box owners, and row details can ask the free US Census geocoder whether it finds the mailing address.
- **Contacts from your other lists.** The same owner at the same property, or at the same mailing address (two name words in common, in any order), is found in every other list in the project; its phones and emails are offered in row details with where they came from, and with any do-not-call or bad-number result recorded there. Another list that names a different owner for the same property (a county roll, say) is flagged. A county export in tab- or pipe-delimited text imports like any list.
- **Emails.** Each email gets a verdict: not an email, a likely typo of a common provider (with the fix), a throwaway domain (a CC0 list bundled with the service), a shared box such as info@, or a domain that takes no mail (an ordinary DNS lookup, kept for a month). An unusable email does not count as a way to reach someone.
- **Area.** Row details show the property's Census tract (no key needed) and, with a free Census key from api.census.gov/data/key_signup.html, the tract's median household income, share of owner-occupied homes, median home value and vacancy. The key stays on this computer.

The Dashboard's *Owners and leads* card counts all of this across the lists.

## Property pictures

Lists, row details and the Dashboard show a picture of each property, from free sources only, in this order:

1. **The row's own picture**, in whatever form its list keeps it: a link, several links in one cell (new lines, commas, `|`), an `<img src="...">` tag, an Excel `=IMAGE("...")` formula, or the picture itself written into the cell (`data:image/...;base64,...` or bare base64). A column counts as pictures by what is in it, not only by its name. A picture written into a cell is saved once in the project's `artifacts/images` folder and travels to the screen on its own; the list's rows are not changed, and downloads keep them as imported. Only `http(s)` links and raster formats are accepted.
2. **A photo of the same property from another list** in the project, matched by street and ZIP (or city), spelled one way ("Street" and "St", a unit after a comma), or by position to about ten metres. A lead takes the listing photo of its house this way.
3. **The USGS aerial view** of its position (public domain, no key), fetched in the background and kept in app data; only the coordinates are sent. A position comes from the list's latitude and longitude, or from its looked-up addresses.
4. A plain house icon.

Photos load without telling their host which page asked. Any list with pictures and a price reads as listings on the Dashboard, imported or collected; without one, the card shows leads whose call reached a person.

## Skip Tracing workflow

All five steps remain: phone columns, call outcomes, warning signs, results, and saving a checked copy.

- Column samples help confirm the proposed mappings. Call statuses are searchable and paginated; every distinct status is available, including those beyond the former 80-status limit. Explicitly ignored meanings stay ignored.
- Call statuses are settled for you where Turf can be sure, and the rest are listed first with the reason ([how](#how-call-statuses-are-read)). What you confirm or ignore is remembered for every list in the project.
- Drafts, completed reports, running job references, and editable setup templates are kept on this computer, keyed by project and list. Templates validate the columns before applying. Storage failures are shown; drafts and templates are not project-file backups.
- Checks save the setup, but never change original rows. Results include all existing reports, an action summary, and paginated row review. Progress and safe cancellation are available; a running job can be reconnected after a screen reload while the service remains alive.
- New manual marks belong to the project, retain source/date/history, and feed the next phone check. DNC has an optional inclusive end date. Called alone does not count as reaching a person. Wrong/reached conflicts remain suspicious; active DNC still blocks a number.
- Saving uses the exact reviewed scan and adds the same verdict/reason/international-format/line-type/best-phone columns. Changes to the setup, project evidence, or calendar date require a new check. Earlier copies remain available; Lists uses the newest copy of an original.
- Project files retain the exact uploaded original and an immutable CSV for every saved checked version. Use **Download original** or **Download checked CSV** in Lists or checked-copy history, including after reopening the project or losing the local upload. Originals keep their uploaded format (including ZIP/GZIP); checked CSVs include every row and original/result column. Older checked copies export from their saved snapshot without running a new check. Keep the project's SQLite file and `artifacts/` folder together when moving or backing it up.
- Phone choices now show **quality** separately from **calling restrictions**, alongside all previous combined verdicts. Active DNC always blocks a recommendation. Numbers are ranked individually (including several in one cell), retain their extensions and source columns, and show why the first choice or alternatives were selected. “No recorded block” describes project evidence; it does not establish consent or permission to call.
- In a reviewed row's **All fields**, or a saved row's details in Lists, open **Phone choices** to record dated, number-specific call outcomes. Reached, wrong person, disconnected, voicemail, no answer, and known wrong number are supported. Wrong person stays scoped to the mapped person; disconnected/known wrong number apply across the project. Voicemail/no answer do not prove connection, ownership, or a bad number. Records can be retracted while retaining their audit history. The project call log is also available beside manual marks.
- Optional street-address/company mappings distinguish possible household and business sharing from unrelated people or unknown relationships. Optional imported call-date columns and configurable age thresholds surface old, undated, and conflicting evidence, including possible reassignment warnings without claiming reassignment is confirmed. New logs and lookup results invalidate old scans; saving still uses the exact reviewed snapshot and records its evidence in lineage metadata.

### How call statuses are read

Three readers look at each status, most trusted first (`service/turf_matching/status_meaning.py`):

1. **Your earlier decisions** for the same wording on any list of the project (punctuation, spacing and dates inside the status don't matter). They always win.
2. **Phrase rules** for common dialer wording, with abbreviations spelled out (LVM, NI, RCB, Disco, WN…). A status is settled only when every word in it is understood and nothing contradicts; one unknown word leaves it for you.
3. **A small local model**, if fetched: it confirms the rules, flags a disagreement, and recognises wording close to something you decided before. It never fills in a meaning on its own from generic examples; measured on unfamiliar wording, those guesses were too often wrong.

Do not call is never dropped on a guess. A status like "DNC: interested" or "DNC until 10/07/2025: Not interested" keeps Do not call but always needs you: "DNC" there may be the dialer's bucket for "stop dialing" with the real reason after it, and only you know whether the person asked not to be called. A wrong-person meaning needs a mapped name column.

The model (Model2Vec `potion-base-8M`, MIT, about 31 MB, CPU and numpy only) sets itself up: the first time Skip Tracing opens a list, it is downloaded once in the background from Hugging Face at a fixed revision, checked against known SHA-256 checksums, and kept in Turf's app data. Until then, or offline, statuses are read without it, and the table updates by itself when it is ready. It needs the `model2vec` package from `service/requirements.txt`.

Lists set up with the earlier version take the new readings by themselves: a saved meaning (or draft) equal to the old version's suggestion is replaced, and one you changed is kept and remembered for the project.

`service/tests/status_wording.py` holds about 225 labelled statuses; the tests check that nothing there is confirmed wrongly and no do-not-call is dropped, with and without the model.

### National Do Not Call Registry

Telemarketers get their first five area codes free at telemarketing.donotcall.gov (register, and renew each year). Download them there and use **Load a file** in Skip Tracing's *Ready to check*. Turf reads ten-digit numbers from the file (flat text, CSV, XML or zipped), keeps them on this computer for every project, and blocks any number on it in a phone check, giving the file's date as the reason. A file replaces the numbers of the area codes it holds, so loading a fresh download refreshes them; numbers in other area codes are not checked. A file older than 31 days still blocks, and the screen asks for a fresh one.

### NANPA number blocks and FEMA flood zones

Skip Tracing's **Ready to check** also accepts NANPA's regional or all-state utilized-code downloads (ZIP or tab-delimited text; CSV, TSV and DAT are supported). Download the text report from [Central Office Code Assignment Records](https://nanpa.com/reports/co-code-reports/cocodes_assign). Turf keeps it on this computer for every project. Missing blocks in a utilized-code file, and explicitly available blocks, add a suspicious reason; assigned blocks do not prove a number is active. Unknown area codes are not judged. Available-only files flag only listed free blocks. NANPA's UA status means unavailable for assignment and is retained, not treated as vacant. Loading another file invalidates reviewed scans; recheck before saving. After 90 days the screen asks for a newer download.

Expand a row in **Lists** to see its FEMA flood zone when property coordinates are available. Only coordinates go to FEMA; successful responses are cached on this computer. Pending requests finish in the background. Connection errors provide **Try again**, with a US VPN suggestion when the connection is refused or reset. No returned data means unknown flood risk, not no risk; see [FEMA's Flood Map Service Center](https://msc.fema.gov/portal/home) for map coverage.

### Use an existing dialer

In **Call outcomes**, use **Import dialer results** for a CSV/Excel export, or select an export already in this project. Choose the exact dialed phone column, call-status column, and optional call date/time column. Map the exported statuses, then **Save outcome mappings**. Return to your lead list and run the normal phone check; the mapped dialer export contributes cross-list evidence without a Twilio account or subscription. Existing steps, rules, reports, downloads, and saved versions remain available.

Status mappings include wrong number, DNC, reached, wrong person, disconnected, voicemail, and no answer. Wrong-person evidence stays associated with the named person; missing names require review rather than marking everyone with that phone number wrong. When an export omits ZIP, a matching mapped name and phone can still identify that person; conflicting supplied ZIPs remain separate. ISO call timestamps retain time and offset (normalized to UTC); date-only values remain usable. Voicemail and no answer record activity only. Direct dialer API synchronization is not configured by importing an export.

### Optional live phone lookup (advanced)

External lookup is separate from the dialer workflow. Only if you want an additional service, open **Advanced: optional external lookup**, then **Optional live phone lookup** in Skip Tracing to configure [Twilio Lookup v2](https://www.twilio.com/docs/lookup/v2-api). Account SID/Auth Token credentials are stored only in this computer's application-data directory (`phone-lookup-settings.json`, mode 0600 on Unix), outside project folders and exports. Blank credential fields keep the existing credentials; **Remove credentials** disables lookup. Existing results remain in their projects.

Line type intelligence supplies carrier/type when supported; optional [Line Status](https://www.twilio.com/docs/lookup/v2-api/line-status) requires provider product access and coverage. Enter the combined USD price per number for your selected products to preview estimated cost; blank means cost unknown, never free. Estimates exclude taxes and account-specific fees. Set a maximum batch size and preview requests/cost before explicitly sending numbers. Only phone numbers are sent, without names or addresses. No provider requests run automatically during a normal check.

Successful results for the same products are reused within the configured cache age, numbers are deduplicated, and concurrent paid batches in one project are rejected. Each request retains a timestamp, provider, result/error, and estimated cost. Stop retains completed responses. The panel reconnects to its saved job after a screen reload; a service restart marks interrupted jobs as failed and retains completed responses for reuse. Failed lookups never become evidence. Fresh inactive results block recommendations; old or temporarily unreachable results prompt review. Carrier/type/availability never prove ownership. Check phones again to incorporate new results; original and previously saved versions remain unchanged.
- Reviewed scan rows and evidence history are retained in the project database; checks therefore use additional disk space. Closing the service interrupts running jobs; reopening the project recovers them as interrupted rather than resuming partial work.

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
| `src-tauri/src/store.rs` | Area mappings and earlier computer-wide marks in `turf.json`. New manual marks and their history are saved in the project database. Earlier marks can be explicitly imported into a project without deleting the old store. |
| `service/turf_service/` | The service: the command router, projects, lists, jobs and the Skip Tracing commands. An import leaves out empty rows and columns; lists already in a project get the same when it is opened (`tidy.py`). |
| `service/turf_matching/` | Phone reading and the Skip Tracing rules, including how call statuses are read (`status_meaning.py`). |
| `service/turf_service/geo.py` | Where rows go on the map: the centre of their ZIP (a file shipped with Turf, checked against the row's state), or their exact address once it has been looked up. The lookup starts by itself the first time a list with a street and a ZIP (or city and state) is shown in Lists, says so under the map, and can be stopped; what was found is kept in the project and not asked for again. It sends street, city, state and ZIP to the US Census Bureau's geocoder; nothing else leaves the computer. |
| `service/migrations/` | The project database's schema. |
| `vite.config.ts` | For a browser tab only: serves `/rpc` over the same bridge. |

## Not done yet

- **No installer.** A packaged Turf would ship the service built into one executable (`service/turf-service.exe`); the host already looks for it there. Until then Turf runs from source and needs Python.
- **Listings come from DataForge.** Turf has no collector; a collected run shows in Turf when its project is opened here.
- **Turf and DataForge open at once on one project** has not been tested. Opening a project recovers interrupted jobs, so do not open a project in Turf while DataForge is running a job on it.
- **The street map needs the internet the first time.** Its background comes from OpenFreeMap (OpenStreetMap data, free, no key) and ZIP outlines from the US Census Bureau; only map addresses and ZIP codes are asked for, never a row. The desktop host keeps every piece on disk (`src-tauri/src/mapcache.rs`, and the service's outline folder), so what was looked at before draws without a connection. Parts never looked at do not, and the cache has no size limit yet.
