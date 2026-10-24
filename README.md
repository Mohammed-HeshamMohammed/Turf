# Turf

The place to manage your lists and the areas they cover.

Start with [PLAN.md](PLAN.md). The mockup that started the idea is in `reference/` (only its look is a reference: revenue, appointments, messages and agent names are not part of Turf).

**Layout.** `Turf/` is the desktop app described below (paths like `src/` and `src-tauri/` are inside it, so run its `npm` commands from `Turf/`). `Full CRM Turf/` is the full CRM app. `service/` (Python engine), `backend/`, `website/`, `contracts/` and `docs/` are shared and stay at the root.

## How it is built

The same stack as DataForge. Everything Turf runs is in this repository; it does not call into the DataForge folder.

| Part | Technology | What it does |
| --- | --- | --- |
| Window | React + TypeScript (`src/`) | The four tabs: Dashboard, Lists, Skip Tracing, Calls. It never touches files or the database itself. |
| Host | Rust + Tauri 2 (`src-tauri/`) | The desktop window with its own title bar. Starts the service, forwards commands to it (restarting it if it does not answer within 3 minutes), and keeps what Turf itself saves. The window has a content security policy: scripts and styles from the app only, pictures from anywhere, connections only to the host and its map cache. |
| Service | Python (`service/`) | Projects, lists and Skip Tracing, in a project folder (SQLite). Copied from DataForge; see [service/SOURCE.md](service/SOURCE.md). |

A project is the same folder format as DataForge's, so a DataForge project opens in Turf.

The frontend service client lives in `src/lib/service/`: `transport.ts` handles browser/native calls, `jobs.ts` watches jobs, and the other modules group project, dataset, Skip Tracing, local-state and enrichment operations. `src/lib/service.ts` remains the shared public entry point. Internal service modules import the transport directly to avoid cycles.

Lists composes `ListRowDetail`, `OwnerPanel`, `EmailWithVerdict` and `MapNote`; table column selection lives in `src/lib/list-columns.tsx`. Skip Tracing's screen (`src/tabs/SkipTracing.tsx`) draws the heading, the progress of a running check and the way between the steps; each of the five steps is its own component (`src/components/SkiptraceStep*.tsx`), and what they share (the setup being edited, the statuses, the running check, its report and the draft) is one hook, `useSkiptraceSetup` in `src/lib/skiptrace-setup.ts`. It delegates readiness and report details to `SkiptraceReadiness` and `SkiptraceReportDetails`, with configuration rules in `src/lib/skiptrace-workflow.ts`. DNC and NANPA share `RegistryFileImport` for loading files while retaining their own coverage and age messages.

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

Runs the linter (ESLint) and the format check (Prettier), the type check and build of the window, UI interaction tests (Vitest), the service's tests (pytest), and the host's tests (cargo). `npm run format` rewrites the screens and their tests in the house format. Every push to `main` and every pull request runs the same checks on GitHub (`.github/workflows/check.yml`). For checks that do not need desktop libraries, run `npm run build`, `npm test`, and `python -m pytest service/tests -q`.

## Package it

```bash
pip install pyinstaller
npm run package
```

This builds the service into one executable (`service/dist/turf-service.exe`, by `service/tools/build_service.py`), then the Windows installer with it and the migrations inside (`src-tauri/tauri.package.conf.json`). The installer is written under `src-tauri/target/release/bundle/nsis/`. A packaged Turf starts that executable and needs no Python; run from source, it still uses Python as before.

The build needs a few gigabytes free. On a drive without room, send the working files elsewhere: `python service/tools/build_service.py --work D:\build`, and set `CARGO_TARGET_DIR` for the host's build.

## Long lists

A list of up to 50,000 rows is read whole into the window, which counts, filters and maps it by itself. A longer one is counted and paged by the service instead (`service/turf_service/views.py`): Lists shows it a page at a time, filtered by the service (verdict, flag, a column, search, area), and the Dashboard takes its counts (verdicts, how rows can be reached, areas, where its rows are) from the service. The service applies the window's own rules, and on a 60,000-row list both give the same counts. On that list the Dashboard opened in about 5 seconds with the window holding 26 MB.

What needs every row of every list at once is left out for a long list: owners and contacts found in other lists, pictures borrowed from them, and each property on its own address on the map (a long list is drawn by ZIP). An email in a long list counts as a way to reach someone without its domain being looked up.

## Adding lists, and never the same one twice

Drop a list's file anywhere on the window to add it to the open project; several files are added one after another. While a file is held over the window, the whole window says where it will go. **Import** in Lists and in the menu do the same for one file.

A file whose rows are already in the project is not added again, whatever it is called now. Turf reads each row as the values it holds, not as its columns' names or their order, so the same list is known again as another file, in another format (a spreadsheet where it was a CSV), with its columns renamed or moved, or with different capitals and spacing (`service/turf_service/sameness.py`). It is refused when it is the same file, the same rows, or a part of a list that is here; the message names the list, and **Add it all the same** adds it if that is what you want. A file that holds a list and more is added, and says how much of it is new; one that shares some rows with a list says how many, so you can combine the two.

Each list's rows are kept as a small sketch in the project, so adding a file never reads every other list again. Up to 4,096 rows the answer is exact; for a longer list it is an estimate within a percent or two. A file with some of a list's columns left out is not recognised as that list.

## Combining lists

**Combine** in Lists makes one list out of several. Pick the lists and Turf compares their rows with the same rules as [repeated leads](#repeated-leads), so a lead that is in two lists under different spellings is one lead, and one owner with several properties stays several rows. The lists need not have the same columns: each is read with its own Skip Tracing setup, and a list that was never set up (a county roll with "Owner" and "Site Address", with no phones at all) is read from its columns' names.

Before anything is saved you see what the lists share: how many leads each has, how many are only there, how many are in another list too, the leads found in more than one list, and the pairs that might be the same lead. You can overrule any of them there. Then choose what the new list holds: every lead once, only the leads in more than one list or in all of them, or only the leads one list has and the others do not (what is new in this month's list, say).

Each lead is one row: the row with the best number to call, else one with a phone, else the most complete, with what the other lists have for it filled in where it is empty. One list's "Owner" and another's "Owner Name" are one column. A phone or email of another row that found no empty cell goes in `Other phones` or `Other emails`; `In lists` and `Combined from` say where each row came from. The lists themselves are not changed, and the combined list is a list like any other: it can be checked in Skip Tracing, downloaded, or combined again.

## Calling the leads

**Calls** works a checked list one lead at a time. Each lead is there once (repeated rows are left out), with the number worth calling first and its other usable numbers below; a click on a number dials it through the computer's own phone app. Beside each number is the time it is where the number is, from its area code, and whether that is inside 8 am to 9 pm, the federal (TCPA) calling window. Some states are stricter and a moved number keeps its old area code, so the time is a warning to look at, not a permission; a number in several zones is inside the window only when it is in every one of them.

One click says how the call went: reached, voicemail, no answer, wrong number, disconnected, or do not call. It is recorded as the call evidence Skip Tracing already uses, so the next phone check knows it. A call that gets no answer moves on to the next lead; one that reaches someone stays in view to set where the lead stands.

**Where a lead stands** is its stage (new, contacted, interested, not interested, dead), a callback day with what it is about, and notes. A lead is its property (street number, street, unit and ZIP), or its phone when the row has no address, so all of it follows the lead into every list of the project that holds it, whatever the list calls its columns. It is set in Calls and in a row's details in Lists. Leads not interested or dead leave the queue; a callback comes back on its day, first in the queue and on the Dashboard's *Callbacks due* card, which opens the lead in Calls.

### Working leads day to day

Some of this follows what a CRM such as EspoCRM does, cut down to one person working lists on one computer (so there are no users, roles or teams):

- **History.** Every call, note, stage change and callback is kept against the lead, and shows under *History* in the lead's panel. The Dashboard's *Recent activity* card shows the newest across the project, each with a link to the lead.
- **Follow-up rules.** After a call the service does what the project's rules say: by default a callback 2 days after no answer and 3 after a voicemail (a callback already set is kept), and a new lead reached becomes contacted. A lead can also be closed as dead after so many calls in a row reach no one (off by default). The rules are set at the top of Calls, and what they did shows in the history.
- **Board.** *Board* in Calls shows the list's leads in a column per stage; drag a card, or pick a stage on it, to move the lead.
- **Callback times and reminders.** A callback can have a time of day. When it comes, a reminder shows in the corner of the window with *Call now*, once per session.
- **Many rows at once.** Tick rows in Lists (or every row a filter matches) to set their stage or callback, or mark their numbers do not call. Each lead is changed once however many rows it has.
- **Call statistics.** The Dashboard's *Calls made* card counts calls a day over two weeks, with the share that reached a person and the outcomes.
- **Search everywhere.** The box in the title bar finds a phone number (however it is written), a name or a street in every list of the project, and opens the row in Lists.

## Handing a list on

In Lists, beside the downloads:

- **Call list**: a CSV for a dialer, made from the list's check. Each lead once, its best number in `Phone` and its other usable numbers in `Other phones`, with its stage, callback day and latest note; leads with no number to call, repeats, and (unless asked for) leads not interested or dead are left out, and the message says how many.
- **Mail list**: a CSV for letters. Each owner once at where their mail goes (the same address however it is spelled), with the property it is about. It can be only absentee owners, only rows with no phone, and without PO boxes.

## Keeping a project safe

- **Deleting a list sets it aside for 30 days.** *Deleted lists* under the lists puts it back with everything it had (its rows, setup, checks and stored file), or deletes it for good. A list deleted more than 30 days ago is let go the next time the project is opened. A deleted list does not stop the same file from being added again.
- **Back up this project**, in the menu behind the mark in the title bar, writes one zip with the project's database and every stored file. Unpacked into an empty folder, it opens as the project. The desktop window asks where to save it; a browser tab puts it in the project's `backups` folder.
- **Filters can be kept by name** for each list (*Keep this filter* in the filter bar) and chosen again from *Saved filters*.
- **Comparing lists** also points out properties that another list names a different owner for: sold since, or one list is wrong.

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

All five steps remain: phone columns, call outcomes, warning signs, results, and saving a checked copy. The check also finds rows that repeat the same lead ([how](#repeated-leads)).

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

### Repeated leads

A phone check also looks for rows that repeat the same lead, and says so in its results. It uses DataForge's matching engine (candidate groups, field-by-field evidence, guards that keep different people and different properties apart, and a likelihood estimated from the list itself), with the columns of the Skip Tracing setup; there is no second setup. On top of the engine, for lists of leads (`service/turf_matching/duplicates.py`):

- **One owner with several properties is not a duplicate.** Those rows are told apart and reported as the same owner, so one call can cover them all.
- **Names as lists write them.** "SMITH JOHN A" and "John Smith" are one name; a company is compared without "LLC" or "Inc."; "SMITH JOHN & MARY" is a household, not one person. People of one household with different first names are never merged.
- **Different phones do not count against a pair.** Two rows for one lead often carry different numbers, which is what skip tracing returns. The same phone alone, with no name or address to go with it, is only a possible repeat.
- **An office line or placeholder is not evidence.** A phone or email on more than five rows under more than two names is left out.
- **The row to keep** is the one with the best number to call, then the most complete, then the first. When a repeat has a phone the kept row lacks, the kept row says so.

No row is removed. The checked copy gets four columns: `Duplicate group`, `Duplicate status` (Keep, Duplicate of row N, or Possible duplicate of row N), `Duplicate why`, and `Same owner rows`. Results show the groups and open them for review, the kept row first; in Lists, the Flag filter shows each lead once, only the repeats, or only the possible ones. It can be turned off under More settings in Warning signs. A check compares the rows of one list; to compare lists with one another, [combine them](#combining-lists).

No group of rows is left out for being large. Rows are compared when they share something (a phone, an email, a street number and street, a name in one ZIP), and inside a group of up to 60 such rows every pair is compared. A larger group (a common name in a big ZIP, a tower of flats at one address) is gone through by a second thing its rows share, and each row with its five nearest by name and address, so the work grows with the number of rows and not with its square. The same row written many times is settled once. On a 200,000-row test list this step took about 45 seconds.

**You can overrule any answer.** In the review of a check, a row marked as a duplicate has *Not the same lead*, and a possible one has *Same lead* as well. Your answer is kept with the project (in the `match_constraints` table DataForge's review uses), dates the check so that it asks to be made again, and is followed from then on whatever the rules would say; the results list your answers and each can be taken back. A check saved before Turf looked for repeated leads offers to be made again.

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

A ReadyMode **call log report** is recognised as it is exported: `Log Type` is the status column, `Log Time` the call time (US `8/10/2026 22:19` date-times are kept with their time), `Phone` plus `Ph#2`…`Ph#10` the numbers, and `Agent name` is never taken for the lead. Its `0` in unused `Ph#` slots counts as empty. All nine Log Types are settled by the rules: Transfer, Callback, Not interested and Spanish Speaker mean someone answered; Voicemail is voicemail; Not Available and Dead Call record activity only; Wrong Number and Do Not Call are applied as such.

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
| `src/components/CrmCards.tsx`, `FollowUpRules.tsx`, `service/turf_service/crm.py` | Activity, call statistics, callback reminders, search everywhere and the follow-up rules. |
| `src/components/DropImport.tsx`, `CombineLists.tsx` | Dropping files on the window, and combining lists into one. |
| `service/turf_service/sameness.py`, `combine.py` | Knowing a list's rows again whatever the file is called; combining lists, and what the person decided about rows being the same lead. |
| `service/turf_matching/` | Phone reading and the Skip Tracing rules, including how call statuses are read (`status_meaning.py`) and how repeated leads are found and lists combined (`duplicates.py` and `combine.py`, on DataForge's `engine.py`, `normalize.py` and `likelihood.py`). |
| `service/turf_service/geo.py` | Where rows go on the map: the centre of their ZIP (a file shipped with Turf, checked against the row's state), or their exact address once it has been looked up. The lookup starts by itself the first time a list with a street and a ZIP (or city and state) is shown in Lists, says so under the map, and can be stopped; what was found is kept in the project and not asked for again. It sends street, city, state and ZIP to the US Census Bureau's geocoder; nothing else leaves the computer. |
| `service/migrations/` | The project database's schema. |
| `vite.config.ts` | For a browser tab only: serves `/rpc` over the same bridge, to Turf's own page and no other. |
| `service/tools/build_service.py`, `src-tauri/tauri.package.conf.json` | Packaging: the service as one executable, and the installer that carries it. |

## Not done yet

- **Calling hours are the federal window only.** State rules (stricter hours, Sundays and holidays) are not known to Turf.
- **Dropping a file on the desktop window** uses the window's own drop event, which has not been tried by hand; dropping on a browser tab has.

- **The installer is not signed, and is for Windows only.** Windows will warn about an unknown publisher until it is signed. The installed app has been started and seen to launch its own service; its screens have not been gone through one by one in that form.
- **Calls reads a long list whole.** Lists and the Dashboard show a list of more than 50,000 rows through the service (below), but Calls still reads the list into the window to order its queue: on 60,000 rows it opens in about 3 seconds and holds about 140 MB.
- **Listings come from DataForge.** Turf has no collector; a collected run shows in Turf when its project is opened here.
- **Turf and DataForge open at once on one project** has not been tested. Opening a project recovers interrupted jobs, so do not open a project in Turf while DataForge is running a job on it.
- **The street map needs the internet the first time.** Its background comes from OpenFreeMap (OpenStreetMap data, free, no key) and ZIP outlines from the US Census Bureau; only map addresses and ZIP codes are asked for, never a row. The desktop host keeps every piece on disk (`src-tauri/src/mapcache.rs`, and the service's outline folder), so what was looked at before draws without a connection. Parts never looked at do not, and the cache has no size limit yet.
