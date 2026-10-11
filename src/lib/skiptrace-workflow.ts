import type { Dataset, Outcome, SkiptraceConfig, SkiptraceReport, StatusRow } from "./types";

export type WorkflowDraft = {
  base: SkiptraceConfig;
  outcomeColumn: string | null;
  called: string;
  meaning: Record<string, import("./types").Outcome[]>;
  reviewed: string[];
  step: number;
  copyName: string;
  report: SkiptraceReport | null;
  scannedWith: string | null;
  activeJob?: { id: string; kind: "scan" | "apply"; configKey: string } | null;
  /** 2 once the status meanings come from today's readers; drafts saved before then hold the earlier suggestions. */
  readings?: number;
};
export type SetupTemplate = { id: string; name: string; config: SkiptraceConfig; at: string };

export function missingColumns(config: SkiptraceConfig, columns: string[]): string[] {
  return [...new Set([...config.phone_columns, config.country_column, config.first_name_column, config.last_name_column,
    config.name_column, config.zip_column, config.state_column, config.address_column, config.city_column, config.business_column, config.vacancy_column,
    config.mailing_address_column, config.mailing_city_column, config.mailing_state_column, config.mailing_zip_column, config.owner_type_column,
    ...(config.additional_owners ?? []).flatMap(owner => Object.values(owner)), ...Object.keys(config.phone_owner_map ?? {}),
    config.call_date_column, config.outcome?.column, config.outcome?.called_column]
    .filter((column): column is string => Boolean(column) && !columns.includes(column!)))];
}

/** Whether the owner of the called phone column has a name column, which a wrong-person meaning needs. */
export function namesMapped(config: SkiptraceConfig, called: string): boolean {
  const owners = config.additional_owners ?? [];
  const index = config.phone_owner_map?.[called] ?? (owners.length ? -1 : 0);
  const person = index === 0 ? config : owners[index - 1] ?? {};
  return Boolean(person.first_name_column || person.last_name_column || person.name_column);
}

export const sameOutcomes = (a: Outcome[] = [], b: Outcome[] = []) => a.length === b.length && a.every(item => b.includes(item));

/** Statuses the service settled by itself, unless the person has given them another meaning. */
export function settledKeys(table: StatusRow[], meaning: Record<string, Outcome[]> = {}): string[] {
  return table.filter(item => item.confirmed && (meaning[item.key] === undefined || sameOutcomes(meaning[item.key], item.outcomes))).map(item => item.key);
}

/**
 * Takes newer readings of the same statuses (the model became ready, or a draft from the earlier version is opened)
 * without undoing the person: a status they settled or gave another meaning keeps it, everything else takes the new
 * reading, and is settled when the new reading is sure.
 */
export function refreshReadings(previous: StatusRow[], next: StatusRow[], meaning: Record<string, Outcome[]>, reviewed: string[]) {
  const before = new Map(previous.map(item => [item.key, item]));
  const nextMeaning = { ...meaning };
  const stays = new Set<string>();
  for (const item of next) {
    const old = before.get(item.key);
    const chosen = meaning[item.key];
    const personal = old !== undefined && reviewed.includes(item.key) && !old.confirmed;
    const edited = old !== undefined && chosen !== undefined && !sameOutcomes(chosen, old.outcomes);
    if (personal || edited) {
      if (reviewed.includes(item.key)) stays.add(item.key);
      continue;
    }
    nextMeaning[item.key] = item.outcomes;
    if (item.confirmed) stays.add(item.key);
  }
  const kept = reviewed.filter(key => stays.has(key));
  return { meaning: nextMeaning, reviewed: [...kept, ...next.filter(item => stays.has(item.key) && !kept.includes(item.key)).map(item => item.key)] };
}

/** What the review column says about a status. */
export function reviewNote(status: StatusRow, reviewed: boolean, chosen: Outcome[] = []): { label: string; detail?: string; needs: boolean } {
  if (!reviewed) return { label: "Needs you", detail: status.why || "Suggested", needs: true };
  if (sameOutcomes(chosen, status.outcomes) && status.sure) {
    if (status.source === "memory" || status.source === "saved") return { label: status.why || "Decided before", needs: false };
    return { label: "Automatic", detail: status.why || "Every word is known dialer wording", needs: false };
  }
  return { label: chosen.length ? "Reviewed" : "Intentionally ignored", needs: false };
}

export function statusPage(statuses: StatusRow[], query: string, unreviewedOnly: boolean, reviewed: string[], page: number, size = 20) {
  const needle = query.trim().toLowerCase();
  const matching = statuses.filter(status => (!needle || status.example.toLowerCase().includes(needle)) && (!unreviewedOnly || !reviewed.includes(status.key)));
  // Statuses still waiting for a decision come first; each one decided drops to the very bottom, so the next one takes
  // its place, and the settled ones stay in the order they were settled.
  const order = new Map(reviewed.map((key, index) => [key, index]));
  const settled = matching.filter(status => order.has(status.key)).sort((a, b) => order.get(a.key)! - order.get(b.key)!);
  const filtered = [...matching.filter(status => !order.has(status.key)), ...settled];
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.min(Math.max(0, page), pages - 1);
  return { rows: filtered.slice(current * size, (current + 1) * size), total: filtered.length, pages, current };
}

export function checkedCopies(datasets: Dataset[], parentId: string) {
  return datasets.filter(item => item.kind === "checked" && item.parent_dataset_id === parentId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

export function readDraft(key: string): WorkflowDraft | null {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "null");
    if (data?.version !== 1 || !Array.isArray(data.state?.base?.phone_columns) || !Array.isArray(data.state?.reviewed)
      || typeof data.state?.meaning !== "object" || !Number.isInteger(data.state?.step)) return null;
    return data.state;
  } catch { return null; }
}

export const STAGE_LABELS: Record<string, string> = {
  recovering: "Reconnecting to the saved job", saving_setup: "Saving the setup", reading_file: "Reading the list", gathering_outcomes: "Gathering outcomes and manual marks",
  checking_phones: "Checking phone numbers", saving_checked_copy: "Saving the reviewed copy",
};

export const SIGN_HELP: Record<string, { example: string; needs: string }> = {
  shared_number: { example: "Two unrelated people are listed with the same phone number.", needs: "Map full name, or first and last name, to compare people." },
  business_line: { example: "A toll-free or premium-rate number appears in a person's phone column.", needs: "Uses the phone number itself; no extra columns needed." },
  area_code_other_state: { example: "A California area code is listed for a Texas property. People can move, so this is a warning, not proof.", needs: "Map a state column; applies to US numbers." },
  country_mismatch: { example: "The phone's country code differs from the property's country.", needs: "Map country, postal code, or state for address evidence." },
};

export function stableKey(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, ordered(child)]));
    return item;
  }
  return JSON.stringify(ordered(value));
}
