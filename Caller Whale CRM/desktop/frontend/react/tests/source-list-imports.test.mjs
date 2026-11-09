import test from "node:test";
import assert from "node:assert/strict";
import { importPath, importStatusMessage, sourceListProgress } from "../src/remote/source-list-imports.js";

test("source rows appear before leads and move from unprocessed to processed as cleaning advances", () => {
  const job = { id: "j", project_id: "p", name: "Texas", status: "loading", loaded_rows: 400, merged_rows: 0, report: { exact_duplicates: 10, empty_rows: 5 }, progress: { phase: "loading", done: 400 } };
  assert.deepEqual(sourceListProgress([job]), { hasImport: true, sourceRows: 385, processedRows: 0, unprocessedRows: 385, addedRows: 0, needsAction: false, inProgress: true });
  job.status = "cleaning";
  job.progress = { phase: "cleaning", done: 200 };
  assert.equal(sourceListProgress([job]).processedRows, 200);
  assert.equal(sourceListProgress([job]).unprocessedRows, 185);
  job.status = "reviewing";
  job.report.rows = 385;
  assert.equal(sourceListProgress([job]).processedRows, 385);
  assert.equal(sourceListProgress([job]).addedRows, 0);
  assert.equal(sourceListProgress([job]).needsAction, true);
  assert.equal(importPath(job), "lists/p/imports/j");
  assert.match(importStatusMessage(job), /review possible repeats/);
});

test("finished and failed imports keep their source rows distinct from CRM rows", () => {
  const done = { status: "done", loaded_rows: 100, merged_rows: 72, report: { rows: 90 }, progress: { phase: "done" } };
  const failed = { status: "failed", loaded_rows: 20, merged_rows: 0, report: { rows: 20 }, progress: { phase: "cleaning", done: 5 } };
  assert.deepEqual(sourceListProgress([done, failed]), { hasImport: true, sourceRows: 110, processedRows: 95, unprocessedRows: 15, addedRows: 72, needsAction: true, inProgress: false });
});
