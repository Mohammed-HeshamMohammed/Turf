import { runJob } from "./jobs";
import { call, inDesktop } from "./transport";

// Working the leads: where each one stands, notes, callbacks, the files made for a dialer or for mail, deleted
// lists, backups and saved filters.

export const STAGES = ["new", "contacted", "interested", "not_interested", "dead"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = { new: "New", contacted: "Contacted", interested: "Interested", not_interested: "Not interested", dead: "Dead" };

export type LeadState = { stage: Stage; callback_on: string | null; callback_note: string; updated_at?: string };
export type ListLeads = { keys: Record<string, string>; states: Record<string, LeadState>; notes: Record<string, number> };
export type LeadNote = { id: string; note: string; at: string };
export type Callback = { lead_key: string; label: string; on: string; note: string; stage: Stage; dataset_id: string; list: string; row_number: number; due: boolean };
export type Due = { today: string; due: Callback[]; coming: Callback[]; stages: Record<Stage, number> };

type Row = { dataset_id: string; row_number: number };

export const listLeads = (dataset_id: string) => call<ListLeads>("leads.for_list", { dataset_id });
export const getLead = (row: Row) => call<{ lead_key: string; state: LeadState | null }>("leads.get", row);
export const setLead = (row: Row, change: { stage?: Stage; callback_on?: string | null; callback_note?: string }) =>
  call<LeadState & { lead_key: string }>("leads.set", { ...row, ...change });
export const leadNotes = (row: Row) => call<LeadNote[]>("leads.notes", row);
export const addLeadNote = (row: Row, note: string) => call<LeadNote[]>("leads.add_note", { ...row, note });
export const removeLeadNote = (row: Row, id: string) => call<LeadNote[]>("leads.remove_note", { ...row, id });
/** The day here, not in Greenwich: a callback for "today" is due when this computer's calendar says so. */
export const localDay = (when = new Date()) => `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}-${String(when.getDate()).padStart(2, "0")}`;
export const dueCallbacks = () => call<Due>("leads.due", { today: localDay() });
export const callingZones = (numbers: string[]) => call<Record<string, string[]>>("calling.zones", { numbers });

/** Records how a call to one of a row's numbers went. */
export const recordCall = (row: Row, number: string, outcome: string, notes = "") => call<{ id: string }>("phone.record_outcome", { ...row, number, outcome, notes });

// ------------------------------------------------------------------------------------------------ exports

export type ExportKind = "calls" | "mail";
export type ExportOptions = { columns?: string[]; skip_stages?: Stage[]; absentee_only?: boolean; no_phone_only?: boolean; skip_po_boxes?: boolean };
type Prepared = { token: string; filename: string; size: number; rows: number; left_out: Record<string, number> };

/** Makes the file and hands it over: saved where the person chooses (desktop) or downloaded (a browser tab).
 * Returns what was written, or null when the person closed the save dialog. */
export async function exportList(kind: ExportKind, dataset_id: string, options: ExportOptions = {}): Promise<Prepared | null> {
  const made = await call<Prepared>("export.prepare", { kind, dataset_id, options });
  if (inDesktop) {
    const path = await (await import("@tauri-apps/plugin-dialog")).save({ defaultPath: made.filename, filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return null;
    await call("export.save", { token: made.token, path });
    return made;
  }
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < made.size; ) {
    const piece = await call<{ data: string }>("export.chunk", { token: made.token, offset });
    const bytes = Uint8Array.from(atob(piece.data), character => character.charCodeAt(0));
    if (!bytes.length) throw new Error("The download was interrupted. Please try again.");
    parts.push(bytes.buffer);
    offset += bytes.length;
  }
  const url = URL.createObjectURL(new Blob(parts, { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = made.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return made;
}

// ------------------------------------------------------------------------- deleted lists, backups, filters

export type Trashed = { id: string; name: string; kind: string; row_count: number; deleted_at: string; kept_until: string };
/** Takes a list out of the project. It can be put back for 30 days. */
export const trashDataset = (dataset_id: string) => call<{ deleted: string; kept_days: number }>("dataset.trash", { dataset_id });
export const trashedDatasets = () => call<Trashed[]>("dataset.trashed");
export const restoreDataset = (dataset_id: string) => call<{ restored: string }>("dataset.restore", { dataset_id });
/** Deletes a deleted list for good, or all of them. */
export const purgeDatasets = (dataset_id?: string) => call<{ purged: string[] }>("dataset.purge", { dataset_id });

/** Writes the whole project into one zip. In the desktop window the person says where; otherwise it goes into the
 * project's own `backups` folder. Null when the save dialog was closed. */
export async function backupProject(suggested: string): Promise<{ path: string; size: number; files: number } | null> {
  let path: string | undefined;
  if (inDesktop) {
    const chosen = await (await import("@tauri-apps/plugin-dialog")).save({ defaultPath: `${suggested} backup ${localDay()}.zip`, filters: [{ name: "Zip", extensions: ["zip"] }] });
    if (!chosen) return null;
    path = chosen;
  }
  return runJob<{ path: string; size: number; files: number }>("project.backup", { path });
}

export type SavedFilter = { name: string; filter: Record<string, string | null> };
export const savedFilters = (dataset_id: string) => call<SavedFilter[]>("filters.list", { dataset_id });
/** Keeps a filter under a name; `null` removes it. */
export const saveFilter = (dataset_id: string, name: string, filter: SavedFilter["filter"] | null) => call<SavedFilter[]>("filters.save", { dataset_id, name, filter });
