// Shapes follow DataForge's IPC contract (docs/ipc-contract.md) so the sample
// client in dataforge.ts can be swapped for the real one without touching the UI.

export type DatasetKind = "import" | "scrape" | "cleaned" | "checked";

export type Dataset = {
  id: string;
  name: string;
  kind: DatasetKind;
  parent_dataset_id?: string | null;
  source_filename: string;
  row_count: number;
  column_count: number;
  created_at: string;
  mapping_version: number | null;
};

export type Raw = Record<string, string | number | null>;

export type DatasetRow = { id: string; row_number: number; raw: Raw };

export type Verdict = "wrong" | "suspicious" | "unverified" | "corroborated";
export const VERDICTS: Verdict[] = ["corroborated", "unverified", "suspicious", "wrong"];

export type Outcome = "wrong_number" | "do_not_call" | "reached";

export type SkiptraceConfig = {
  phone_columns: string[];
  region: string;
  country_column: string | null;
  first_name_column: string | null;
  last_name_column: string | null;
  name_column: string | null;
  zip_column: string | null;
  state_column: string | null;
  outcome: { column: string; called_column: string; map: Record<string, Outcome[]> } | null;
  signals: Record<string, boolean>;
};

export type StatusRow = { key: string; example: string; count: number; outcomes: Outcome[] };

export type SkiptraceSuggestion = {
  dataset_id: string;
  rows: number;
  columns: string[];
  config: SkiptraceConfig;
  saved: boolean;
  outcome_candidates: { column: string; filled: number; distinct: number }[];
  outcome_column: string | null;
  statuses: StatusRow[];
  outcomes: { id: Outcome; label: string }[];
  signals: { code: string; label: string; measured_only: boolean }[];
};

export type ColumnReport = {
  column: string; filled: number; filled_share: number; valid: number; valid_share: number; distinct: number; wrong: number;
  adds_info: number; adds_info_share: number; verdicts: Record<Verdict, number>; verdict_text: string;
};

export type SignReport = {
  code: string; label: string; contacted: number; wrong: number; wrong_rate: number | null; lift: number | null;
  counted: boolean; measured_only: boolean; predictive: boolean; enough_data: boolean;
};

export type SkiptraceReport = {
  rows: number; rows_with_phone: number; rows_with_callable_number: number; values: number;
  verdicts: Record<Verdict, number>;
  reasons: { code: string; label: string; count: number; effect: string; examples: { row: number; column: string; value: string; text: string }[] }[];
  columns: ColumnReport[];
  types: Record<string, number>;
  countries: Record<string, number>;
  repairs: { note: string; count: number }[];
  outcomes: {
    available: boolean; rows: Record<string, number>; baseline_wrong_rate: number | null; contacted: number; known_wrong_numbers: number;
    do_not_call_numbers: number; expired_do_not_call_numbers: number; carried_rows: number; carried_wrong_number: number; carried_do_not_call: number;
  };
  signals: SignReport[];
  metadata_version: string;
  other_datasets_used: string[];
};

export type AreaLevel = "state" | "city" | "zip";
export type AreaMapping = Partial<Record<AreaLevel, string>>;

/** A mark made by hand in Turf, kept per phone number so it follows the number into every list. */
export type ManualMark = "called" | "wrong_number" | "do_not_call" | "interested";
