import { streetColumn } from "./geo";
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
  const progress: Progress = {
    reached: 0,
    no_pickup: 0,
    bad_number: 0,
    do_not_call: 0,
    unclear: 0,
    no_result: 0,
    column: setup.outcome_column,
    statusesNeedingYou: 0,
    rowsNeedingYou: 0,
  };
  let counted = 0;
  for (const status of setup.statuses) {
    progress[progressKind(status)] += status.count;
    counted += status.count;
    if (status.key && !status.confirmed) {
      progress.statusesNeedingYou += 1;
      progress.rowsNeedingYou += status.count;
    }
  }
  progress.no_result += Math.max(0, setup.rows - counted); // rows with an empty status
  return progress;
}

export type ListFacts = {
  dataset: Dataset;
  rows: number;
  checked: boolean;
  phoneRows: number;
  zipColumn?: string;
  zipless: number;
  progress: Progress | null;
  /** Rows without a phone of their own whose owner has one in another list. */
  phonesElsewhere?: number;
};
export type NextStep = { key: string; text: string; detail: string; action: string; tab: "skiptracing" | "lists"; datasetId: string; weight: number };

/** What is worth doing next, biggest first: lists not checked yet, statuses that need the person, rows off the map. */
export function nextSteps(lists: ListFacts[]): NextStep[] {
  const steps: NextStep[] = [];
  for (const list of lists) {
    const name = list.dataset.name;
    if (!list.checked && list.phoneRows > 0) {
      steps.push({
        key: `check-${list.dataset.id}`,
        text: `Check the phones in ${name}`,
        detail: `${list.phoneRows.toLocaleString()} rows have a phone; a check finds the ones worth calling`,
        action: "Check",
        tab: "skiptracing",
        datasetId: list.dataset.id,
        weight: list.phoneRows,
      });
    }
    if (list.progress?.statusesNeedingYou) {
      const { statusesNeedingYou: count, rowsNeedingYou: rows } = list.progress;
      steps.push({
        key: `statuses-${list.dataset.id}`,
        text: `${count} call ${count === 1 ? "status" : "statuses"} in ${name} ${count === 1 ? "needs" : "need"} you`,
        detail: `Used on ${rows.toLocaleString()} rows; Turf could not settle ${count === 1 ? "it" : "them"} alone`,
        action: "Review",
        tab: "skiptracing",
        datasetId: list.dataset.id,
        weight: rows,
      });
    }
    if (list.phonesElsewhere) {
      steps.push({
        key: `found-${list.dataset.id}`,
        text: `${list.phonesElsewhere.toLocaleString()} rows in ${name} have no phone, but another list has one`,
        detail: "Same owner at the same property or mailing address; open a row to see it and where it came from",
        action: "Open",
        tab: "lists",
        datasetId: list.dataset.id,
        weight: list.phonesElsewhere * 1.5,
      });
    }
    if (!list.zipColumn && list.rows) {
      steps.push({
        key: `zip-${list.dataset.id}`,
        text: `${name} has no ZIP column`,
        detail: "Its rows are not on the map or in Areas until a ZIP column is chosen",
        action: "Open",
        tab: "lists",
        datasetId: list.dataset.id,
        weight: list.rows / 2,
      });
    } else if (list.zipless > Math.max(10, list.rows * 0.05)) {
      steps.push({
        key: `zipless-${list.dataset.id}`,
        text: `${list.zipless.toLocaleString()} rows in ${name} have no ZIP`,
        detail: "They are left off the map and out of Areas",
        action: "Open",
        tab: "lists",
        datasetId: list.dataset.id,
        weight: list.zipless / 2,
      });
    }
  }
  return steps.sort((a, b) => b.weight - a.weight);
}

// ---------------------------------------------------------------------------------------------- how to reach a row

/** Each row by the best way to reach it, each row once. Colours are a validated categorical set (see the dataviz notes in
 * styles.css); "do not call" uses the critical status colour and always comes with its label. */
export const REACH = [
  { id: "ready", label: "Ready to call", hint: "A checked list found a number worth calling", color: "#2a78d6" },
  { id: "phone", label: "Phone, not checked yet", hint: "Has a phone number; a check sorts the good ones from the bad", color: "#eb6834" },
  { id: "email", label: "Email only", hint: "No phone, but an email address", color: "#1baf7a" },
  { id: "mail", label: "Mail only", hint: "No phone or email; only an address to mail", color: "#eda100" },
  { id: "blocked", label: "Do not call or bad number", hint: "A call status or a phone check says not to call", color: "#d03b3b" },
  { id: "none", label: "No contact info", hint: "Nothing to reach them by; these need skip tracing", color: "#cfcdc6" },
] as const;
export type ReachKind = (typeof REACH)[number]["id"];

const DATE_AFTER_UNTIL = /\b(until|till|through|thru|expires?|exp)\s*:?\s*(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4})/gi;

/** A status value as the service keys it (turf_matching.skiptrace.normalize_status): spacing folded, a date after
 * "until" replaced, lower case. */
export function statusKey(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(DATE_AFTER_UNTIL, (_, word: string) => `${word.toLowerCase()} [date]`)
    .toLowerCase();
}

/** The columns a letter could go to: the mailing address the setup maps (or one named so), else the property's street. */
export function mailColumnsOf(columns: string[], setup?: SkiptraceSuggestion | null): string[] {
  const own = ownColumns(columns);
  const config = setup?.config;
  const mapped = [config?.mailing_address_column, ...(config?.additional_owners ?? []).map(owner => owner.mailing_address_column)].filter(
    (column): column is string => Boolean(column) && own.includes(column!),
  );
  if (mapped.length) return [...new Set(mapped)];
  const named = own.filter(name => /^(owner\s*)?mail(ing)?\s*(address|addr|street)/i.test(name.trim()));
  if (named.length) return named;
  const street = streetColumn(own);
  return street ? [street] : [];
}

export type ReachContext = {
  phoneColumns: string[];
  emailColumns: string[];
  mailColumns: string[];
  /** Status column and what each status key means, when the list has call results. */
  statusColumn?: string;
  statusKinds?: Map<string, ProgressKind>;
  /** Whether an email can reach someone, once checked; until then any address counts. */
  emailOk?: (address: string) => boolean;
};

export function reachContext(columns: string[], setup?: SkiptraceSuggestion | null, emailOk?: (address: string) => boolean): ReachContext {
  const kinds = setup?.outcome_column ? new Map(setup.statuses.filter(status => status.key).map(status => [status.key, progressKind(status)])) : undefined;
  return {
    phoneColumns: phoneColumnsOf(columns, setup),
    emailColumns: ownColumns(columns).filter(name => EMAIL_NAME.test(name)),
    mailColumns: mailColumnsOf(columns, setup),
    statusColumn: setup?.outcome_column ?? undefined,
    statusKinds: kinds,
    emailOk,
  };
}

/** How a row can be reached. `callable` is the phone check's answer (null when the list is not checked); a call status
 * that says do not call wins over everything, as it does when calling. */
export function reachOf(row: DatasetRow, context: ReachContext, callable: boolean | null): ReachKind {
  const kind = context.statusColumn ? context.statusKinds?.get(statusKey(row.raw[context.statusColumn])) : undefined;
  const hasPhone = context.phoneColumns.some(column => digits(row.raw[column]) >= 7);
  if (kind === "do_not_call") return "blocked";
  if (callable !== null && hasPhone) return callable ? "ready" : "blocked";
  if (hasPhone) return kind === "bad_number" ? "blocked" : "phone";
  const emails = context.emailColumns.flatMap(column => String(row.raw[column] ?? "").match(/[^@\s,;<>"']+@[^@\s,;<>"']+\.[a-z]{2,}/gi) ?? []);
  if (emails.some(email => !context.emailOk || context.emailOk(email.toLowerCase()))) return "email";
  if (context.mailColumns.some(column => String(row.raw[column] ?? "").trim().length > 3)) return "mail";
  return "none";
}

/** A share as people read it: under one percent is "<1%", never a misleading 0%. */
export function shareText(part: number, whole: number): string {
  if (!whole || !part) return "0%";
  const value = (part / whole) * 100;
  return value < 1 ? "<1%" : `${Math.round(value)}%`;
}

// ------------------------------------------------------------------------------------------ listings and follow-ups

export type ListingFields = { price?: string; beds?: string; baths?: string; area?: string; days?: string; status?: string; link?: string };

/** The columns a listing card reads, found by name in any list shaped like listings. */
export function listingFields(columns: string[]): ListingFields {
  const own = ownColumns(columns);
  const find = (pattern: RegExp) => own.find(name => pattern.test(name.trim()));
  return {
    price: find(/^(list(ing)? )?price$|^asking price$/i),
    beds: find(/^(beds?|bedrooms?)$/i),
    baths: find(/^(baths?|bathrooms?)$/i),
    area: find(/living area|^sq\.? ?ft$|square feet|^sqft$|building size/i),
    days: find(/days on (zillow|market)|^dom$/i),
    status: find(/^(listing )?status$/i),
    link: find(/detail url|listing url|^url$|^link$|property url/i),
  };
}

// A call that reached someone who said no is a result, not a lead: "Not interested", "NI", "Sold", "Hung up".
const REFUSAL =
  /\b(not|no longer|never|isn'?t|wasn'?t)\s+(interested|selling|for sale|the owner)\b|\bn\/?i\b|\bno interest\b|\b(already )?sold\b|\bhung up\b|\brefus|\bdeclin|\bremove (me|from)\b|\bstop calling\b/i;

/** Whether a row whose call reached a person is worth following up, by what its status says. */
export function worthFollowingUp(status: unknown): boolean {
  return !REFUSAL.test(String(status ?? ""));
}
