// Uploading a list to Caller Whale's server and following it through the steps (docs/plans/crm-core-and-imports.md). The browser cuts the
// file into pieces the server names (about 8 MB), sends three at a time, each with its SHA-256 fingerprint; a piece that fails is sent
// again, and an upload that was interrupted carries on from the pieces the server already holds. The server does the rest.

import { api as defaultApi, ApiError, apiBase, auth, organization } from "./api.ts";

export type ImportJob = {
  id: string;
  name: string;
  filename: string;
  size: number;
  chunk_size: number;
  total_chunks: number;
  status: string;
  progress: { phase?: string; done?: number; total?: number };
  columns: ImportColumn[];
  report: Record<string, any>;
  error: string;
  loaded_rows: number;
  merged_rows: number;
  kind?: "lead_list" | "readymode_calls";
  source_timezone?: string;
  received?: number[];
};

export type ImportColumn = {
  idx: number;
  header: string;
  suggested: string | null;
  source_detail?: string | null;
  standard_key?: string | null;
  /** The heading as the server compares it, and whether this workspace answered for it before. */
  key?: string;
  remembered?: "used" | "unused" | null;
  field: string | null;
  used: boolean | null;
  populated: number;
  samples: string[];
};

export type ImportApi = {
  start(body: { filename: string; size: number; name?: string; project_id?: string; has_header?: boolean; kind?: string; source_timezone?: string; skip_tracing?: boolean }): Promise<ImportJob>;
  get(id: string): Promise<ImportJob>;
  piece(id: string, n: number, bytes: ArrayBuffer, sha256: string, signal?: AbortSignal): Promise<unknown>;
  complete(id: string): Promise<ImportJob>;
};

/** The CRM fields a column can be, in the order people expect them, with the words shown. */
export const IMPORT_FIELDS: [string, string][] = [
  ["name", "Name"],
  ["first_name", "First name"],
  ["last_name", "Last name"],
  ["phone", "Phone"],
  ["email", "Email"],
  ["address", "Address"],
  ["unit", "Unit"],
  ["city", "City"],
  ["region", "State or region"],
  ["zip", "ZIP or postal code"],
  ["country", "Country"],
  ["latitude", "Latitude"],
  ["longitude", "Longitude"],
  ["parcel", "Parcel number"],
  ["value", "Value"],
  ["source", "Source"],
];

/** Additional columns kept as structured source data and, where applicable, property details. */
export const SOURCE_IMPORT_FIELDS: [string, string][] = [
  ["source_record_id", "Source record ID"], ["county", "County"], ["living_area", "Living area"],
  ["year_built", "Year built"], ["lot_size_acres", "Lot size (acres)"], ["lot_size_square_feet", "Lot size (square feet)"],
  ["land_use", "Land use"], ["property_type", "Property type"], ["property_use", "Property use"],
  ["subdivision", "Subdivision"], ["legal_description", "Legal description"], ["units", "Units"],
  ["bedrooms", "Bedrooms"], ["bathrooms", "Bathrooms"], ["stories", "Stories"],
  ["garage_type", "Garage type"], ["garage_area", "Garage area"], ["carport", "Carport"],
  ["carport_area", "Carport area"], ["cooling", "Air conditioning"], ["heating", "Heating"],
  ["fireplaces", "Fireplaces"], ["owner_1_first_name", "Owner 1 first name"], ["owner_1_last_name", "Owner 1 last name"],
  ["owner_2_first_name", "Owner 2 first name"], ["owner_2_last_name", "Owner 2 last name"],
  ["owner_3_first_name", "Owner 3 first name"], ["owner_3_last_name", "Owner 3 last name"],
  ["owner_4_first_name", "Owner 4 first name"], ["owner_4_last_name", "Owner 4 last name"],
  ["owner_mailing_address", "Owner mailing address"], ["owner_mailing_city", "Owner mailing city"],
  ["owner_mailing_state", "Owner mailing state"], ["owner_mailing_zip", "Owner mailing ZIP"],
  ["ownership_length", "Ownership length"], ["owner_type", "Owner type"],
  ["owner_occupied", "Owner occupied"], ["vacancy", "Vacancy"],
  ["batch_name", "Batch name"], ["original_file_name", "Original file name"],
  ["upload_date", "Upload date"], ["status", "Status"], ["original_status", "Original status"],
  ["status_time", "Status time"], ["status_agent", "Status agent"], ["lead_file_campaign", "Lead file campaign"],
];

/** The statuses where the server waits for the person (or has finished), so following the import can pause. */
export const WAITING = ["mapping", "reviewing", "ready", "call_ready", "done", "failed", "cancelled"];

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

const pause = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new DOMException("Cancelled", "AbortError"))), { once: true });
  });

/** The server's answer for one piece, over fetch with the bearer token (the JSON helper in api.ts does not send raw bytes). */
async function sendPiece(id: string, n: number, bytes: ArrayBuffer, sha256: string, signal?: AbortSignal, retried = false): Promise<unknown> {
  const token = await auth.accessToken().catch(() => null);
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/api/v1/imports/${id}/chunks/${n}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "x-chunk-sha256": sha256,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(token && organization() ? { "x-callerwhale-org": organization() } : {}),
      },
      body: bytes,
      signal,
    });
  } catch (reason: any) {
    if (reason?.name === "AbortError") throw reason;
    throw new ApiError(0, "offline", "The server cannot be reached");
  }
  if (response.status === 401 && token && !retried && (await auth.refresh().catch(() => null))) return sendPiece(id, n, bytes, sha256, signal, true);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiError(response.status, data?.error?.code || "error", data?.error?.message || "The server refused the piece");
  }
  return response.json();
}

export const importApi: ImportApi = {
  start: (body) => defaultApi.imports.start(body),
  get: (id) => defaultApi.imports.get(id),
  piece: sendPiece,
  complete: (id) => defaultApi.imports.complete(id),
};

export type UploadOptions = {
  name?: string;
  projectId?: string;
  kind?: "lead_list" | "readymode_calls";
  sourceTimezone?: string;
  hasHeader?: boolean;
  /** The list has addresses but no phone numbers or emails yet: it is for skip tracing, so it is let in. */
  skipTracing?: boolean;
  /** Carry on an upload that was interrupted. */
  resumeId?: string;
  parallel?: number;
  retries?: number;
  api?: ImportApi;
  signal?: AbortSignal;
  onProgress?: (progress: { sent: number; total: number; job: ImportJob }) => void;
  /** Milliseconds to wait before sending a piece again; tests make it 0. */
  backoff?: number;
};

/** Sends the file. Resolves with the job once the server has every piece and has queued it. */
export async function uploadFile(file: Blob & { name: string }, options: UploadOptions = {}): Promise<ImportJob> {
  const api = options.api ?? importApi;
  const job = options.resumeId
    ? await api.get(options.resumeId)
    : await api.start({
        filename: file.name,
        size: file.size,
        name: options.name,
        project_id: options.projectId,
        has_header: options.hasHeader,
        skip_tracing: options.skipTracing,
        kind: options.kind,
        source_timezone: options.sourceTimezone,
      });
  if (job.status !== "uploading") return job;
  const held = new Set(job.received ?? []);
  const pieces = Array.from({ length: job.total_chunks }, (_, n) => n).filter((n) => !held.has(n));
  const length = (n: number) => Math.min(job.chunk_size, file.size - n * job.chunk_size);
  let sent = [...held].reduce((sum, n) => sum + length(n), 0);
  options.onProgress?.({ sent, total: file.size, job });
  let next = 0;
  const lane = async () => {
    while (next < pieces.length) {
      const n = pieces[next++];
      const bytes = await file.slice(n * job.chunk_size, n * job.chunk_size + length(n)).arrayBuffer();
      const sum = await sha256Hex(bytes);
      for (let attempt = 0; ; attempt += 1) {
        try {
          await api.piece(job.id, n, bytes, sum, options.signal);
          break;
        } catch (reason: any) {
          // A refusal that sending again cannot fix (no permission, a bad file) stops the upload; trouble on the way does not.
          const mayRetry =
            reason?.name !== "AbortError" && (!(reason instanceof ApiError) || reason.status === 0 || reason.status >= 500 || reason.status === 422);
          if (!mayRetry || attempt >= (options.retries ?? 4)) throw reason;
          await pause((options.backoff ?? 600) * 2 ** attempt, options.signal);
        }
      }
      sent += length(n);
      options.onProgress?.({ sent, total: file.size, job });
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.parallel ?? 4, pieces.length) }, lane));
  return api.complete(job.id);
}

/** Follows an import until it reaches a status where the server waits for the person (or is finished). */
export async function follow(
  id: string,
  onUpdate: (job: ImportJob) => void,
  {
    signal,
    every = 1500,
    get = defaultApi.imports.get,
  }: {
    signal?: AbortSignal;
    every?: number;
    get?: (id: string) => Promise<ImportJob>;
  } = {},
): Promise<ImportJob> {
  for (;;) {
    const job = await get(id);
    onUpdate(job);
    if (WAITING.includes(job.status)) return job;
    await pause(every, signal);
  }
}

/** The answer to send for the columns: what each one is, taken from the person's choices (their own, else the suggestion). */
export function mappingBody(columns: ImportColumn[], choices: Record<number, string | null | undefined>) {
  return {
    columns: columns.map((column) => {
      const field = choices[column.idx] === undefined ? (column.suggested ?? (column.source_detail ? column.standard_key : null)) : choices[column.idx];
      return field ? { idx: column.idx, field, use: true } : { idx: column.idx, use: false };
    }),
  };
}

/** Why the mapping cannot be sent yet, or "". */
export function mappingProblem(columns: ImportColumn[], choices: Record<number, string | null | undefined>, skipTracing = false): string {
  const body = mappingBody(columns, choices).columns as { field?: string }[];
  const fields = body.map((c) => c.field).filter(Boolean) as string[];
  const once = fields.filter((f) => f !== "phone" && f !== "email");
  const repeated = once.find((f, i) => once.indexOf(f) !== i);
  if (repeated)
    return `Two columns are set to ${[...IMPORT_FIELDS, ...SOURCE_IMPORT_FIELDS].find(([key]) => key === repeated)?.[1] ?? repeated}. Only phone and email can come from more than one.`;
  if (!fields.some((f) => ["name", "first_name", "last_name"].includes(f))) return "Keep a name column: leads need a name.";
  if (skipTracing) {
    if (!fields.some((f) => ["phone", "email", "address"].includes(f))) return "A list for skip tracing needs an address column (or a phone or an email column).";
  } else if (!fields.some((f) => ["phone", "email"].includes(f))) return "Keep a phone or an email column: a list that nobody can contact is not added. A list of addresses only can be added when it is marked as being for skip tracing.";
  return "";
}
