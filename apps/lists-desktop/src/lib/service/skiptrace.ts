import type { ManualMarks } from "../marks";
import type { ManualMark, Outcome, SkiptraceConfig, SkiptraceReport, SkiptraceSuggestion, StatusModelState, StatusRow, Verdict, ReviewRow } from "../types";
import { call } from "./transport";
import { runJob, type JobWatch } from "./jobs";

// A list's proposed or saved setup is asked for once and kept, so opening Skip Tracing on it again is immediate.
// Saving a setup changes the answer, so that list's entry is dropped then.
const suggestions = new Map<string, { value?: SkiptraceSuggestion; promise: Promise<SkiptraceSuggestion> }>();

export function skiptraceSuggest(dataset_id: string) {
  let entry = suggestions.get(dataset_id);
  if (!entry) {
    const created: { value?: SkiptraceSuggestion; promise: Promise<SkiptraceSuggestion> } = {
      promise: call<SkiptraceSuggestion>("skiptrace.suggest", { dataset_id }).then(
        value => (created.value = value),
        reason => {
          if (suggestions.get(dataset_id) === created) suggestions.delete(dataset_id);
          throw reason;
        },
      ),
    };
    suggestions.set(dataset_id, created);
    entry = created;
  }
  return entry.promise;
}

/** The setup if it has already arrived, without waiting. */
export const knownSuggestion = (dataset_id: string) => suggestions.get(dataset_id)?.value ?? null;

export const clearSuggestions = () => suggestions.clear();
export const skiptraceStatuses = (dataset_id: string, column: string, region: string, names_mapped = true) =>
  call<StatusRow[]>("skiptrace.statuses", { dataset_id, column, region, names_mapped });
export const skiptraceModelStatus = () => call<{ state: StatusModelState; done?: number; total?: number; detail?: string }>("skiptrace.model_status");
/** Keeps the person's status decisions for the whole project (null forgets one). Every list's suggestion may change. */
export const skiptraceRemember = (dataset_id: string, decisions: Record<string, Outcome[] | null>) => {
  suggestions.clear();
  return call<{ remembered: number }>("skiptrace.remember", { dataset_id, decisions });
};
export const skiptraceSave = (dataset_id: string, config: SkiptraceConfig) => {
  suggestions.delete(dataset_id);
  return call<SkiptraceConfig>("skiptrace.save_settings", { dataset_id, config });
};
export const skiptraceScan = (dataset_id: string, config: SkiptraceConfig, watch?: JobWatch) => runJob<{ report: SkiptraceReport }>("skiptrace.scan", { dataset_id, config }, watch);
export const skiptraceApply = (dataset_id: string, config: SkiptraceConfig, name?: string, scan_job_id?: string, watch?: JobWatch) =>
  runJob<{ dataset_id: string; rows: number; added_columns: string[]; verdicts: Record<Verdict, number>; rows_with_callable_number: number }>("skiptrace.apply", { dataset_id, config, name, scan_job_id }, watch);
export const skiptraceFreshness = (dataset_id: string) => call<{ fingerprint: string; date: string }>("skiptrace.freshness", { dataset_id });
export const skiptraceReview = (job_id: string, filter: string, offset: number, row_number?: number) => call<{ total: number; rows: ReviewRow[] }>("skiptrace.review", { job_id, filter, offset, limit: 25, row_number });
export const cancelSkiptraceJob = (job_id: string) => call("job.cancel", { job_id });
export const projectMarks = () => call<ManualMarks>("marks.list");
export const importLegacyMarks = (marks: ManualMarks) => call<ManualMarks>("marks.import_legacy", { marks });
export const markHistory = () => call<{ number: string; mark: ManualMark | null; at: string; until?: string | null; source: string }[]>("marks.history");
