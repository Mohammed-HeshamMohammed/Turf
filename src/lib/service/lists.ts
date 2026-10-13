import { runJob, type JobWatch } from "./jobs";
import { call, ServiceError } from "./transport";

// Adding files without adding the same list twice, combining lists, and what the person decided about rows being
// the same lead.

/** The list that already holds a file's rows. */
export type Already = { dataset_id: string; name: string; rows: number; share: number; how: "same_file" | "same_rows" | "all_inside" };
export type Overlap = { dataset_id: string; name: string; rows: number; share: number; of_other: number };
export type Imported = {
  dataset_id: string;
  row_count: number;
  dropped_empty_rows?: number;
  dropped_empty_columns?: number;
  /** Lists already in the project that share rows with this one. */
  overlaps?: Overlap[];
};
type ImportAnswer = Omit<Imported, "dataset_id"> & { dataset_id: string | null; already?: Already | null };

const ALREADY: Record<Already["how"], (already: Already) => string> = {
  same_file: already => `This file is already in the project, as “${already.name}”.`,
  same_rows: already => `The same rows are already in the project, as “${already.name}”, under another file name or other column names.`,
  all_inside: already => `Every row of this file is already in “${already.name}”, which has ${already.rows.toLocaleString("en-US")} rows.`,
};

/** A file was not added because the project already holds its rows. `already` says which list; adding it all the
 * same is the person's choice. */
export class AlreadyHere extends ServiceError {
  readonly already: Already;
  constructor(already: Already) {
    super("already_here", `${ALREADY[already.how](already)} It was not added again.`);
    this.already = already;
  }
}

function added(answer: ImportAnswer): Imported {
  if (!answer.dataset_id) {
    if (answer.already) throw new AlreadyHere(answer.already);
    throw new ServiceError("invalid_response", "The file was not added");
  }
  return { ...answer, dataset_id: answer.dataset_id };
}

/** Adds a file by its path on this computer. Refused with `AlreadyHere` when its rows are in the project already. */
export const importFile = async (path: string, allowDuplicate = false) =>
  added(await runJob<ImportAnswer>("dataset.import", { path, allow_duplicate: allowDuplicate }));

/** Adds a file by its content: a browser tab knows what was dropped on it, but not where the file is. */
export async function importContent(file: File, allowDuplicate = false) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return added(await runJob<ImportAnswer>("dataset.import_content", { name: file.name, data: btoa(binary), allow_duplicate: allowDuplicate }));
}

/** What a file shares with lists already here, in words, or nothing. */
export function describeOverlaps(imported: Imported): string {
  const most = imported.overlaps?.[0];
  if (!most) return "";
  const share = (part: number) => `${Math.max(1, Math.round(part * 100))}%`;
  return most.of_other >= 0.98
    ? `It holds every row of “${most.name}” and more: ${share(1 - most.share)} of it is new.`
    : `${share(most.share)} of its rows are also in “${most.name}”. Combine the two to have each lead once.`;
}

// ---------------------------------------------------------------------------------------------- combining lists

export type CombineMode = "all" | "shared" | "in_all" | `only:${string}`;
export type LeadRow = { dataset_id: string; list: string; row_number: number; label: string };
export type CombineSummary = {
  mode: CombineMode;
  lists: { dataset_id: string; name: string; rows: number; leads: number; only_here: number; elsewhere: number }[];
  counts: { all: number; shared: number; in_all: number; only: number[] };
  rows_in: number;
  rows_out: number;
  repeats_within: number;
  examples: { why: string; size: number; rows: LeadRow[] }[];
  possible: { why: string; size: number; rows: LeadRow[] }[];
  possible_pairs: number;
  compared_pairs: number;
  overruled: number;
};

/** Compares the lists and says what combining them would give, without saving anything. */
export const compareLists = (dataset_ids: string[], watch?: JobWatch) =>
  runJob<{ summary: CombineSummary }>("lists.combine", { dataset_ids, preview: true }, watch).then(result => result.summary);

/** Saves the combined list as a new list. The lists it is made from stay as they are. */
export const combineLists = (dataset_ids: string[], mode: CombineMode, name: string, watch?: JobWatch) =>
  runJob<{ dataset_id: string; rows: number; columns: number; summary: CombineSummary }>("lists.combine", { dataset_ids, mode, name }, watch);

// ------------------------------------------------------------------------------- what the person decided

export type Overrule = { same: boolean; at: string; dataset_id: string; row_number: number; other_dataset_id: string; other_row_number: number };

/** Says that two rows are the same lead (true), are not (false), or takes back what was said (null). */
export const overrule = (dataset_id: string, row_number: number, other_row_number: number, same: boolean | null, other_dataset_id?: string) =>
  call<{ overrules: Overrule[] }>("duplicates.overrule", { dataset_id, row_number, other_row_number, same, other_dataset_id }).then(result => result.overrules);

export const overrules = (dataset_ids: string[]) => call<Overrule[]>("duplicates.overrules", { dataset_ids });
