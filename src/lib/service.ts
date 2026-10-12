// The window's side of Turf's application service (service/, Python). The bridge follows DataForge's:
// in the desktop window commands go through the Rust host (`service_call`); in a browser tab they go to the
// dev server, which talks to the service the same way the host does. The UI never touches SQLite, files or workers directly.

import type { ManualMarks } from "./marks";
import type { AreaMapping, Dataset, DatasetRow, ManualMark, Outcome, SkiptraceConfig, SkiptraceReport, SkiptraceSuggestion, StatusModelState, StatusRow, Verdict, ReviewRow } from "./types";

type Envelope<T> = { schema_version: 1; ok: true; result: T } | { schema_version: 1; ok: false; error: { code: string; message: string } };

export class ServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(command: string, args?: Record<string, unknown>) {
  return (await import("@tauri-apps/api/core")).invoke<T>(command, args);
}

function unwrap<T>(response: unknown): T {
  const envelope = response as Envelope<T> | undefined;
  if (!envelope || envelope.schema_version !== 1 || typeof envelope.ok !== "boolean") throw new ServiceError("invalid_response", "Turf's service returned an unexpected response");
  if (!envelope.ok) {
    // The screens are newer than the service they are talking to. Say what to do, not the command's name.
    const message = envelope.error.code === "unknown_command" ? "Turf's service is older than its screens. Close Turf and open it again." : envelope.error.message;
    throw new ServiceError(envelope.error.code, message);
  }
  return envelope.result;
}

export async function call<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (inDesktop) {
    try {
      return unwrap<T>(await invoke("service_call", { command, payload }));
    } catch (reason) {
      // The host rejects with a plain string when the service cannot be started or reached.
      throw reason instanceof Error ? reason : new ServiceError("bridge_unavailable", String(reason));
    }
  }
  // The dev server forwards this to the service one request at a time (vite.config.ts).
  const turn = fetch("/rpc", { signal: AbortSignal.timeout(120_000), method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ schema_version: 1, command, payload }) });
  let response: Response;
  try {
    response = await turn;
  } catch {
    throw new ServiceError("bridge_unavailable", "Turf's service is not answering. Start Turf with `npm run dev` or `npm run desktop`.");
  }
  if (!response.ok) throw new ServiceError("bridge_unavailable", "Turf's service is not answering. It needs Python 3.11+ with service/requirements.txt installed.");
  return unwrap<T>(await response.json());
}

// ---------------------------------------------------------------- jobs

export type Job<R = Record<string, unknown>> = { id: string; kind: string; state: string; result: R | null; error: string | null };

const FINISHED = ["completed", "failed", "cancelled"];

/**
 * Starts a long-running command and waits for its job, as the service reports it. `onEvent` gets each progress
 * event the job writes; `onStart` gets the job's id, which is what cancelling needs.
 */
export async function runJob<R>(command: string, payload: Record<string, unknown>, watch: { onStart?: (jobId: string) => void; onEvent?: (payload: Record<string, unknown>) => void } = {}): Promise<R> {
  const { job_id } = await call<{ job_id: string }>(command, payload);
  return watchJob<R>(job_id, watch);
}

export async function watchJob<R>(job_id: string, watch: { onStart?: (jobId: string) => void; onEvent?: (payload: Record<string, unknown>) => void } = {}): Promise<R> {
  watch.onStart?.(job_id);
  let seen = 0;
  for (;;) {
    const job = await call<Job<R> & { events?: { id: number; payload: Record<string, unknown> }[] }>("job.get", { job_id, after_event_id: seen });
    for (const event of job.events ?? []) {
      seen = Math.max(seen, event.id);
      watch.onEvent?.(event.payload);
    }
    if (job.state === "completed" && job.result) return job.result;
    if (FINISHED.includes(job.state)) throw new ServiceError(`job_${job.state}`, job.error ?? `The job was ${job.state}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

// ---------------------------------------------------------------- projects

/** What was taken out of one list because it held nothing. */
export type LeftOut = { name?: string; dropped_empty_rows?: number; dropped_empty_columns?: number };

export type Project = {
  id: string; name: string; root_path: string; created_at: string;
  /** Lists that lost empty rows or columns when the project was opened. */
  tidied?: LeftOut[];
};

/** "3 empty columns", "2 empty rows and 1 empty column", or nothing when nothing was left out. */
export function describeLeftOut({ dropped_empty_rows: rows = 0, dropped_empty_columns: columns = 0 }: LeftOut) {
  const count = (amount: number, word: string) => `${amount.toLocaleString("en-US")} empty ${word}${amount === 1 ? "" : "s"}`;
  return [rows && count(rows, "row"), columns && count(columns, "column")].filter(Boolean).join(" and ");
}

export const currentProject = () => call<Project | null>("project.current");
export const recentProjects = () => call<Project[]>("project.recent");
export const openProject = (path: string) => call<Project>("project.open", { path });
export const createProject = (path: string, name: string) => call<Project>("project.create", { path, name });

export async function pickFolder() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export async function pickImportFile() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({
    multiple: false, directory: false, filters: [{ name: "Lists", extensions: ["csv", "tsv", "txt", "xlsx", "json", "jsonl", "parquet"] }],
  });
  return typeof selected === "string" ? selected : null;
}

// ---------------------------------------------------------------- lists

export const listDatasets = () => call<Dataset[]>("dataset.list");
export const importFile = (path: string) => runJob<{ dataset_id: string; row_count: number; dropped_empty_rows?: number; dropped_empty_columns?: number }>("dataset.import", { path });

export const renameDataset = (dataset_id: string, name: string) => call<{ dataset_id: string; name: string }>("dataset.rename", { dataset_id, name });
/** Removes the list and its rows from the project. Lists made from it stay. */
export const deleteDataset = (dataset_id: string) => call<{ deleted: string }>("dataset.delete", { dataset_id });

/** The service returns at most 5,000 rows a call. */
export const datasetRows = (dataset_id: string, offset: number, limit: number) => call<DatasetRow[]>("dataset.rows", { dataset_id, offset, limit });

const PAGE = 5000;

export async function allRows(dataset_id: string) {
  const rows: DatasetRow[] = [];
  for (;;) {
    const page = await datasetRows(dataset_id, rows.length, PAGE);
    // Ends on an empty page, not a short one, so it is right whatever page size the service allows.
    if (!page.length) return rows;
    rows.push(...page);
  }
}

// ---------------------------------------------------------------- skip tracing

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
export type JobWatch = { onStart?: (jobId: string) => void; onEvent?: (payload: Record<string, unknown>) => void };
export const skiptraceScan = (dataset_id: string, config: SkiptraceConfig, watch?: JobWatch) => runJob<{ report: SkiptraceReport }>("skiptrace.scan", { dataset_id, config }, watch);
export const skiptraceApply = (dataset_id: string, config: SkiptraceConfig, name?: string, scan_job_id?: string, watch?: JobWatch) =>
  runJob<{ dataset_id: string; rows: number; added_columns: string[]; verdicts: Record<Verdict, number>; rows_with_callable_number: number }>("skiptrace.apply", { dataset_id, config, name, scan_job_id }, watch);
export const skiptraceFreshness = (dataset_id: string) => call<{ fingerprint: string; date: string }>("skiptrace.freshness", { dataset_id });
export const skiptraceReview = (job_id: string, filter: string, offset: number, row_number?: number) => call<{ total: number; rows: ReviewRow[] }>("skiptrace.review", { job_id, filter, offset, limit: 25, row_number });
export const cancelSkiptraceJob = (job_id: string) => call("job.cancel", { job_id });
export const projectMarks = () => call<ManualMarks>("marks.list");
export const importLegacyMarks = (marks: ManualMarks) => call<ManualMarks>("marks.import_legacy", { marks });
export const markHistory = () => call<{ number: string; mark: ManualMark | null; at: string; until?: string | null; source: string }[]>("marks.history");

// ---------------------------------------------------------------- what Turf itself keeps

type TurfState = { marks: ManualMarks; areas: Record<string, AreaMapping> };

// In the desktop window the Rust host owns the file. A browser tab has no host, so development there falls back to browser storage.
const KEY = "turf.state";
function browserState(): TurfState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TurfState> | null;
    return { marks: saved?.marks ?? {}, areas: saved?.areas ?? {} };
  } catch {
    return { marks: {}, areas: {} };
  }
}
function saveBrowserState(state: TurfState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not saved; it still holds for this visit.
  }
  return state;
}

export async function turfState(): Promise<TurfState> {
  return inDesktop ? invoke<TurfState>("turf_state") : browserState();
}

export async function setMark(number: string, mark: ManualMark | null, until?: string | null): Promise<ManualMarks> {
  return call<ManualMarks>("marks.set", { number, mark, until });
}

export async function setAreaColumns(datasetId: string, mapping: AreaMapping): Promise<Record<string, AreaMapping>> {
  if (inDesktop) return invoke<Record<string, AreaMapping>>("turf_set_area_columns", { datasetId, mapping });
  const state = browserState();
  state.areas[datasetId] = mapping;
  return saveBrowserState(state).areas;
}

/** Downloads a project archive; originals retain their exact bytes, checked copies include every column. */
export async function downloadDataset(datasetId: string, version: "original" | "checked", onProgress?: (percent: number) => void): Promise<boolean> {
  const payload = { dataset_id: datasetId, version };
  const info = await call<{ filename: string; size: number; mime: string; hash: string }>("dataset.download", payload);
  if (inDesktop) {
    const path = await (await import("@tauri-apps/plugin-dialog")).save({ defaultPath: info.filename });
    if (!path) return false;
    await call("dataset.download_save", { ...payload, path, hash: info.hash });
  } else {
    const parts: ArrayBuffer[] = [];
    let offset = 0;
    while (offset < info.size) {
      const chunk = await call<{ data: string }>("dataset.download_chunk", { ...payload, hash: info.hash, offset });
      const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
      if (!bytes.length || offset + bytes.length > info.size) throw new Error("The download was interrupted. Please try again.");
      parts.push(bytes.buffer);
      offset += bytes.length;
      onProgress?.(Math.round(offset / info.size * 100));
    }
    const url = URL.createObjectURL(new Blob(parts, { type: info.mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = info.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}

// Pictures: one written into a cell (saved in the project), and the free aerial view of a place.
export const embeddedPicture = (name: string) => call<{ data_url: string }>("images.embedded", { name });
export const aerialPicture = (lat: number, lon: number) =>
  call<{ data_url?: string; credit?: string; pending?: boolean; unavailable?: string }>("images.aerial", { lat, lon });

// The National Do Not Call Registry, from the person's own download; kept on this computer for every project.
export type RegistryStatus = { area_codes: { area_code: string; count: number; imported_at: string; file: string; age_days: number; out_of_date: boolean }[]; numbers: number; max_age_days: number };
export const dncRegistryStatus = () => call<RegistryStatus>("dnc_registry.status");
export const dncRegistryRemove = (area_code: string) => call<RegistryStatus>("dnc_registry.remove", { area_code });
export const dncRegistryImport = (path: string, onLines: (lines: number) => void) =>
  runJob<{ area_codes: string[]; numbers: number; lines: number; skipped_lines: number }>("dnc_registry.import", { path }, {
    onEvent: payload => { if (payload.stage === "reading_registry" && typeof payload.lines === "number") onLines(payload.lines); },
  });
export async function pickRegistryFile() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({
    multiple: false, directory: false, filters: [{ name: "Do Not Call Registry files", extensions: ["txt", "csv", "zip", "xml", "dat"] }],
  });
  return typeof selected === "string" ? selected : null;
}

// NANPA downloads stay on this computer and contribute to every project's phone checks.
export type BlocksStatus = { area_codes: number; assigned: number; oldest_days: number | null; files: string[] };
export const nanpaBlocksStatus = () => call<BlocksStatus>("nanpa_blocks.status");
export const nanpaBlocksImport = (path: string) => runJob<{ area_codes: number; assigned: number; free: number }>("nanpa_blocks.import", { path });
export async function pickNanpaFile() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({
    multiple: false, directory: false, filters: [{ name: "NANPA number blocks", extensions: ["txt", "csv", "zip", "tsv", "dat"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export type FloodZone =
  | { zone: string; risk: "high" | "low" | "unknown"; text: string; pending?: never; unavailable?: never }
  | { pending: true; unavailable?: never; zone?: never; risk?: never; text?: never }
  | { unavailable: string; pending?: never; zone?: never; risk?: never; text?: never };
export const floodZone = (lat: number, lon: number, again = false) => call<FloodZone>("flood.of", { lat, lon, again });

// Email addresses: a verdict for each, with the domain's mail check finishing in the background.
export type EmailVerdict = { verdict: "ok" | "role" | "invalid" | "typo" | "disposable" | "no_mail" | "pending" | "unknown"; why: string; suggestion?: string };
export const checkEmails = (addresses: string[]) => call<Record<string, EmailVerdict>>("emails.check", { addresses });

// The area around a property from the US Census: its tract (no key), and the tract's figures with the person's free key.
export type CensusArea = {
  tract?: { geoid: string; name: string }; needs_key?: boolean; pending?: boolean; unavailable?: string;
  figures?: { year: number; median_income: number | null; median_value: number | null; owner_occupied_share: number | null; vacant_share: number | null } | null;
};
export const censusArea = (lat: number, lon: number) => call<CensusArea>("area.of", { lat, lon });
export const setCensusKey = (key: string) => call<{ configured: boolean }>("area.set_key", { key });
