import type { Dataset, SkiptraceConfig, SkiptraceReport, StatusRow } from "./types";

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

export function statusPage(statuses: StatusRow[], query: string, unreviewedOnly: boolean, reviewed: string[], page: number, size = 20) {
  const needle = query.trim().toLowerCase();
  const filtered = statuses.filter(status => (!needle || status.example.toLowerCase().includes(needle)) && (!unreviewedOnly || !reviewed.includes(status.key)));
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
