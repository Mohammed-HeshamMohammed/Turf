# Make Skip Tracing easier without removing functionality

Reviewed against commit `e12cde1` on 9 October 2026. This is a code-based workflow review, not a visual or user-tested audit. Browser-control tools were unavailable. This document records the original proposal. Its changes have since been implemented; see README.md and the workflow regression tests.

## Requirement

Preserve every existing step, input, rule, report, and output. Improvements should reduce repeated work and explain decisions, while keeping all options available. Do not silently discard rows, phone columns, statuses, reasons, warning signs, or previous checked copies as part of this work.

## Current flow and opportunities

| Step | Current behavior | Opportunity |
| --- | --- | --- |
| 1. Phone columns | Suggested columns; default country; optional row country, names, ZIP, state mappings | Show a few sample values beside each column. Distinguish suggested settings from confirmed settings. Explain which warnings need which mappings. |
| 2. Call outcomes | Pick a status column and the phone column it describes; map statuses to wrong number, do-not-call, reached | Search and filter the status table; show mapped and unreviewed counts. Explicitly distinguish intentionally ignored statuses from statuses awaiting review. Keep multiple compatible meanings. |
| 3. Warning signs | Four configurable signs; duplicate-phone information is measured separately | Explain each sign with an example and its required inputs. Show a review summary before running the check. Keep every toggle and measured-only result. |
| 4. Results | Verdicts, row counts, column usefulness, reasons and examples, measured sign performance, phone types/countries/repairs, manual marks | Put an action summary first. Add links to detailed sections and affected rows. Keep every detailed report. Explain that a usable number may still be suspicious or unverified. |
| 5. Save the copy | Re-evaluates the list and adds verdict, reason, E.164, line type, and best-phone columns | Preview a few original-plus-result rows. Show row and added-column counts, the check date and sources. Explain whether saving creates a new copy. |

## Highest-priority improvements

### 1. Make status mapping easier and complete

The current table presents every status against every outcome. Add search, an unreviewed filter, row counts, and clear explanations. Keep suggested meanings editable; explicitly ignored statuses remain visible and reversible.

The engine currently exposes only the 80 most frequent statuses plus an aggregate row with an empty key. `buildConfig` discards empty keys, so that aggregate cannot actually be mapped. Paginate or otherwise expose the remaining real statuses, rather than offering checkboxes on an unaddressable aggregate. This expands access to existing data; it does not remove any statuses.

### 2. Preserve work and explain what has been saved

The screen says nothing is saved until the last step, but `check()` saves settings before scanning. Say: "Checking saves this setup for future checks. Your original list stays unchanged; the checked copy is saved separately."

Keep drafts per project and list across reloads and navigation. Currently, visited screens retain state for only five lists, and report/draft state is otherwise held in memory. Label settings as suggested, edited, or saved. Offer an editable setup template for repeated file formats, validating that mapped columns still exist.

### 3. Add a decision summary without hiding detail

Lead with rows with a usable number, wrong-number and DNC findings, and records needing review. Counts must clearly distinguish rows, unique numbers, and phone values. A row can contain both a blocked number and another usable number, so avoid implying that every row with a bad phone must be deleted.

Keep all four verdict categories, column-quality analysis, reasons/examples, cross-file sources, baseline comparison, measured-only signals, line types, countries, repairs, and manual marks. Links should open filtered views without deleting or changing source rows.

### 4. Make checks understandable while they run

Use existing job stages to show reading, gathering outcomes, checking, and saving. Expose safe cancellation at supported checkpoints; do not imply immediate cancellation inside an uninterrupted engine evaluation. Prevent setup edits during a run, handle status-loading failures, and discard outdated responses when users switch status columns quickly.

After changing signs with "Use the signs that predict," keep the existing requirement to check again. Explain exactly what changed and provide a way to revert those toggle edits.

### 5. Clarify freshness and checked-copy history

Current stale detection compares only the form configuration with the last scanned configuration. A date change can change DNC expiry, and changes to other lists' saved settings can change cross-file knowledge. Record these dependencies so the user can understand when rechecking is needed.

The save screen says it replaces the existing checked copy, but the service registers a new dataset. Keep history and explicitly identify the latest copy. Define and test which copy Lists uses when multiple copies exist. Because saving re-evaluates, detect or disclose if its result differs from the preview.

### 6. Connect manual marks as a separate engine enhancement

Manual marks currently show on rows but are not inputs to Skip Tracing. Feeding them into the engine would close the feedback loop, but it changes results and deserves a separate implementation with regression coverage.

Retain source, date, project scope, and history of each mark. Define expiry and conflicts with imported outcomes. "Called" alone must not imply that the correct person was reached. Keep manual and imported evidence identifiable.

## Suggested implementation order

1. Clearer save wording, column samples, searchable status mapping, setup summary, and better loading/error feedback.
2. Complete status access, persistent drafts, run stages/cancellation, result-to-row navigation, and accurate copy history/freshness.
3. Reusable validated templates and the manual-mark feedback loop.

## Preservation checks for implementation

- Original input rows remain intact throughout checking and saving.
- All five steps remain accessible, with every existing setting available.
- Outcome mapping retains wrong-number, DNC, reached, compatible combinations, and expiry behavior.
- All four configurable signs and the measured-only duplicate-column sign remain available.
- All existing report sections, source attribution, examples, and output columns remain available.
- Reusing a template never silently changes mappings or applies unsupported columns.
- UI-only changes produce the same reports and checked-copy content for the same inputs and dependencies.
- Engine changes receive coverage for DNC expiry, conflicts, cross-file propagation, and row preservation.

## Sources

- `src/tabs/SkipTracing.tsx`: five-step workflow, outcome mapping, scan/save actions, report sections, manual marks.
- `src/lib/service.ts`: job progress callbacks and Skip Tracing commands.
- `src/lib/hooks.ts`: visited-screen retention and checked-copy selection.
- `service/callerwhale_service/skiptrace.py`: saved settings, project knowledge, checking, new checked-copy registration.
- `service/callerwhale_matching/skiptrace.py`: status limit, status normalization, verdicts, expiry, signal measurement.

## Implementation validation

The implementation retains the five steps and original report sections, adds project-local manual evidence/history and reviewed-row snapshots, and preserves earlier checked copies. Coverage is in `service/tests/test_skiptrace_workflow.py`, `tests/skiptrace-workflow.test.ts`, and `tests/skiptrace-screen.test.tsx`. The frontend build, service regression suite, and DOM interaction tests verify behavior; visual browser verification and desktop execution require capabilities not available in this workspace.
