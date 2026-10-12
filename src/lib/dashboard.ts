import { ownColumns } from "./marks";
import type { Dataset, DatasetRow, SkiptraceSuggestion, StatusRow } from "./types";

// What the Dashboard can tell from a list on its own, before anyone checks its phones, and where the person's own
// decisions (a phone check, call statuses they settled) take over.

const PHONE_NAME = /phone|mobile|cell|\btel\b|telephone/i;
const EMAIL_NAME = /e-?mail/i;

/** The list's phone columns: the ones its Skip Tracing setup uses (saved or suggested), else the ones named like phones. */
export function phoneColumnsOf(columns: string[], setup?: SkiptraceSuggestion | null): string[] {
  const own = ownColumns(columns);
  const fromSetup = (setup?.config.phone_columns ?? []).filter(column => own.includes(column));
  return fromSetup.length ? fromSetup : own.filter(name => PHONE_NAME.test(name));
}

const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "").length;

export type Coverage = { phone: number; severalPhones: number; email: number; neither: number };

/** How many rows can be reached at all: a value with enough digits to be a phone number, or an email address. */
export function contactCoverage(rows: DatasetRow[], columns: string[], phoneColumns: string[]): Coverage {
  const emails = ownColumns(columns).filter(name => EMAIL_NAME.test(name));
  const coverage: Coverage = { phone: 0, severalPhones: 0, email: 0, neither: 0 };
  for (const row of rows) {
    const phones = phoneColumns.filter(column => digits(row.raw[column]) >= 7).length;
    const email = emails.some(column => String(row.raw[column] ?? "").includes("@"));
    coverage.phone += phones > 0 ? 1 : 0;
    coverage.severalPhones += phones > 1 ? 1 : 0;
    coverage.email += email ? 1 : 0;
    coverage.neither += !phones && !email ? 1 : 0;
  }
  return coverage;
}

export const PROGRESS = [
  { id: "reached", label: "Reached a person" },
  { id: "no_pickup", label: "No answer or voicemail" },
  { id: "bad_number", label: "Bad number" },
  { id: "do_not_call", label: "Do not call" },
  { id: "unclear", label: "Status not understood yet" },
  { id: "no_result", label: "No call result yet" },
] as const;
export type ProgressKind = (typeof PROGRESS)[number]["id"];
export type Progress = Record<ProgressKind, number> & { column: string; statusesNeedingYou: number; rowsNeedingYou: number };

/** Where a status puts its rows. Do not call wins, then a bad number, as when calling. */
export function progressKind(status: StatusRow): ProgressKind {
  const outcomes = status.outcomes;
  if (outcomes.includes("do_not_call")) return "do_not_call";
  if (outcomes.some(kind => kind === "wrong_number" || kind === "disconnected" || kind === "wrong_person")) return "bad_number";
  if (outcomes.includes("reached")) return "reached";
  if (outcomes.includes("voicemail") || outcomes.includes("no_answer")) return "no_pickup";
  return status.key && status.confirmed ? "no_result" : "unclear";
}

/**
 * The call results in a list's status column, by what each status means: settled by Turf where it is sure, or by the
 * person; a status that still needs them counts by its suggested meaning, as a phone check would use it.
 */
export function callProgress(setup: SkiptraceSuggestion | null | undefined): Progress | null {
  if (!setup?.outcome_column) return null;
  const progress: Progress = { reached: 0, no_pickup: 0, bad_number: 0, do_not_call: 0, unclear: 0, no_result: 0, column: setup.outcome_column, statusesNeedingYou: 0, rowsNeedingYou: 0 };
  let counted = 0;
  for (const status of setup.statuses) {
    progress[progressKind(status)] += status.count;
    counted += status.count;
    if (status.key && !status.confirmed) {
      progress.statusesNeedingYou += 1;
      progress.rowsNeedingYou += status.count;
    }
  }
  progress.no_result += Math.max(0, setup.rows - counted);  // rows with an empty status
  return progress;
}

export type ListFacts = {
  dataset: Dataset; rows: number; checked: boolean; phoneRows: number; zipColumn?: string; zipless: number; progress: Progress | null;
};
export type NextStep = { key: string; text: string; detail: string; action: string; tab: "skiptracing" | "lists"; datasetId: string; weight: number };

/** What is worth doing next, biggest first: lists not checked yet, statuses that need the person, rows off the map. */
export function nextSteps(lists: ListFacts[]): NextStep[] {
  const steps: NextStep[] = [];
  for (const list of lists) {
    const name = list.dataset.name;
    if (!list.checked && list.phoneRows > 0) {
      steps.push({ key: `check-${list.dataset.id}`, text: `Check the phones in ${name}`, detail: `${list.phoneRows.toLocaleString()} rows have a phone; a check finds the ones worth calling`, action: "Check", tab: "skiptracing", datasetId: list.dataset.id, weight: list.phoneRows });
    }
    if (list.progress?.statusesNeedingYou) {
      const { statusesNeedingYou: count, rowsNeedingYou: rows } = list.progress;
      steps.push({ key: `statuses-${list.dataset.id}`, text: `${count} call ${count === 1 ? "status" : "statuses"} in ${name} ${count === 1 ? "needs" : "need"} you`, detail: `Used on ${rows.toLocaleString()} rows; Turf could not settle ${count === 1 ? "it" : "them"} alone`, action: "Review", tab: "skiptracing", datasetId: list.dataset.id, weight: rows });
    }
    if (!list.zipColumn && list.rows) {
      steps.push({ key: `zip-${list.dataset.id}`, text: `${name} has no ZIP column`, detail: "Its rows are not on the map or in Areas until a ZIP column is chosen", action: "Open", tab: "lists", datasetId: list.dataset.id, weight: list.rows / 2 });
    } else if (list.zipless > Math.max(10, list.rows * 0.05)) {
      steps.push({ key: `zipless-${list.dataset.id}`, text: `${list.zipless.toLocaleString()} rows in ${name} have no ZIP`, detail: "They are left off the map and out of Areas", action: "Open", tab: "lists", datasetId: list.dataset.id, weight: list.zipless / 2 });
    }
  }
  return steps.sort((a, b) => b.weight - a.weight);
}
