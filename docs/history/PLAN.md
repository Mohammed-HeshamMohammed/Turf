# Caller Whale: plan

Caller Whale is the place to manage your lists and the areas they cover. The data comes from DataForge: listings collected through the browser extension, public records, and the phone checks from DataForge's Skip Tracing.

Status: the first version is built (Dashboard, Lists with automatic and manual marks, Skip Tracing). See [README.md](README.md) for how it is built and what is not done. This plan was written 8 October 2026 from the conversation that started it; the open questions below show what was decided since.

## What Caller Whale is for

You work with lists: files of rows, such as a skip-traced export or a run of Zillow listings. Caller Whale is where you:

- see all your lists;
- pick one and see its rows, each with marks (is this number wrong, do-not-call, worth calling);
- see which areas the list covers (state, city, ZIP) and how many rows are in each;
- filter the rows by area, mark, or any column.

## What Caller Whale is not

The first design idea was a brokerage dashboard (reference image in `docs/reference/`). These parts are **dropped** because the data does not exist or is not wanted:

- total revenue, average sale value, completed deals;
- appointments and messages;
- agent names (DataForge's collectors never collect agent names or contacts).

## Tabs

| Tab | What it is |
| --- | --- |
| **Dashboard** | Kept as it is in DataForge, with the useful parts only. |
| **Lists** | New. The lists, the rows of the selected list with their marks, and the areas the list covers. |
| **Skip Tracing** | Kept. Where the phone checks and call outcomes are set up and applied. |

## The Lists tab

1. **Left: the lists.** Each is a dataset from DataForge: name, row count, kind (imported file, collected run, checked copy).
2. **Selecting a list loads its rows.** Marks appear without running anything by hand. They come from the setup saved for that list in Skip Tracing.
3. **Marks on each row:**
   - the phone verdict: wrong, suspicious, unverified, corroborated;
   - the best number to call, and its reason;
   - flags: known wrong number, do-not-call (with its end date, if any).
4. **Areas.** A summary of where the list reaches, by state, city and ZIP, with counts. Clicking an area filters the rows. A small map shows the same areas as dots (latitude and longitude are collected for listings).
5. **Filters and search** on the rows, using the columns the list really has.

If a list has no state, ZIP or city column, Caller Whale says so and lets you map one. It does not guess.

## Marks: automatic and manual (to confirm)

- **Automatic marks** come from DataForge's Skip Tracing and need nothing from you.
- **Manual marks** would let you mark a row yourself: called, wrong number, do-not-call, interested. Those are saved as call outcomes, which is exactly the data Skip Tracing uses to flag the same number in every other row and file. This closes the loop: mark a row in Caller Whale and the number is flagged everywhere.

Manual marks are the second step. They need a place to store them and a way to feed them back as outcomes.

## What Caller Whale reads from DataForge

| Need | Where it comes from in DataForge |
| --- | --- |
| Lists and their rows | `dataset.list`, `dataset.rows` |
| Phone verdicts and best number | the checked copy that `skiptrace.apply` saves (columns `<phone column> (verdict)`, `(why)`, `(E.164)`, `(type)`, and `Best phone`, `Best phone verdict`, `Best phone from`) |
| The saved setup for a list | `skiptrace.suggest` returns it (`saved: true`) |
| Call outcomes | the status column the person mapped in Skip Tracing |
| Listings (price, beds, baths, area, photos, latitude, longitude) | the Zillow collector's dataset |
| Areas | the state, ZIP and city columns of each list, found through the column mapping |

DataForge is the engine. Caller Whale only shows and manages what DataForge has.

## What Caller Whale can show that a generic dashboard cannot

DataForge holds listings, owner and public records, and checked phone numbers. Clean & Combine already matches rows by address. A combined record could show one property with its listing, its owner, the best phone and whether that number is wrong or on a do-not-call list. That is a later step, after Lists.

## Open questions

Decided so far: (1) a separate app with its own copy of the service; (2) the mockup's layout; (3) manual marks from the start, kept by Caller Whale; (6) dots on a plain plot for now. Still open: 4, 5, 7 and the street map.

1. **A tab inside DataForge, a second window of it, or a separate app?** The data lives in a DataForge project, so a tab or window needs no copying. A separate app needs a local API or an export, and is only worth it if people who should not have the collection tools will use it.
2. **Layout.** The mockup uses a top row of pill tabs on a light background. DataForge's own layout is contained sidebar panels with gaps and a status bar. Inside DataForge the second applies; a separate app could follow the mockup.
3. **Marks:** automatic only first, or manual from the start?
4. **Datasets tab:** keep it for importing and raw data and add Lists beside it, or fold it into Lists?
5. **Area levels:** state, city, ZIP, or all three?
6. **The map.** The mockup shows streets, which needs map tiles. Free OpenStreetMap tiles are not for heavy use. Options: tiles stored locally, a paid provider, or dots on a plain plot as the coverage map in DataForge does now.
7. **Photos.** Listing photos are saved as links. Showing them in a private tool is low risk; copying or redistributing them is not.

## Suggested order

1. **Lists tab, first version:** the list picker, the rows with automatic verdict marks, the area summary with filtering.
2. **Manual marks** saved as call outcomes.
3. **Combined property record** (listing + owner + best phone + verdict).
4. **Comparison between runs:** new, removed and price-changed listings.

## Where the related work is (in the DataForge repository)

| What | Where |
| --- | --- |
| Skip Tracing design and rules | `docs/Skip Tracing/Skip Tracing.md` |
| Phone reading and country rules | `workers/matching/src/dataforge_matching/phone.py` |
| Verdicts, outcomes, warning signs | `workers/matching/src/dataforge_matching/skiptrace.py` |
| Skip Tracing commands | `docs/ipc-contract.md`, section "Skip Tracing" |
| The collector extension | `extensions/dataforge-collector/` |
| The plan for the collector | `docs/Scrapper/Bookmarklet Collectors.md` |
