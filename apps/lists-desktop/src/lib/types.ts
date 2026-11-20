// Shapes follow DataForge's IPC contract (docs/ipc-contract.md) so the sample
// client in dataforge.ts can be swapped for the real one without touching the UI.

export type DatasetKind = "import" | "scrape" | "cleaned" | "checked" | "combined";

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
  derivation_json?: string | null;
};

export type Raw = Record<string, string | number | null>;

export type DatasetRow = { id: string; row_number: number; raw: Raw };

export type Verdict = "wrong" | "suspicious" | "unverified" | "corroborated";
export const VERDICTS: Verdict[] = ["corroborated", "unverified", "suspicious", "wrong"];

export type Outcome = "wrong_number" | "do_not_call" | "reached" | "wrong_person" | "disconnected" | "voicemail" | "no_answer";

export type OwnerColumns = {
  first_name_column?: string | null;
  last_name_column?: string | null;
  name_column?: string | null;
  mailing_address_column?: string | null;
  mailing_city_column?: string | null;
  mailing_state_column?: string | null;
  mailing_zip_column?: string | null;
  owner_type_column?: string | null;
};
export type SkiptraceConfig = OwnerColumns & {
  phone_columns: string[];
  region: string;
  country_column: string | null;
  first_name_column: string | null;
  last_name_column: string | null;
  name_column: string | null;
  zip_column: string | null;
  state_column: string | null;
  address_column?: string | null;
  business_column?: string | null;
  city_column?: string | null;
  vacancy_column?: string | null;
  additional_owners?: OwnerColumns[];
  phone_owner_map?: Record<string, number>;
  call_date_column?: string | null;
  evidence_age_days?: number;
  /** Whether the check also looks for rows that repeat the same lead. On unless turned off. */
  find_duplicates?: boolean;
  lookup_age_days?: number;
  outcome: { column: string; called_column: string; map: Record<string, Outcome[]> } | null;
  signals: Record<string, boolean>;
};

/** How a status's meaning was found: the person's earlier choice, the phrase rules, the rules checked by the model,
 * the model alone (only for wording the person decided before), this list's saved setup, or nothing. */
export type StatusSource = "memory" | "rules" | "rules+model" | "model" | "saved" | "none";
export type StatusRow = {
  key: string;
  example: string;
  count: number;
  outcomes: Outcome[];
  confirmed?: boolean;
  sure?: boolean;
  source?: StatusSource;
  why?: string;
  doubt?: string;
  /** What the earlier version of Caller Whale suggested, to tell its old suggestions apart from the person's choices. */
  earlier?: Outcome[];
};
/** The small status model: on this computer, being fetched (first time only), or not available. */
export type StatusModelState = "ready" | "downloading" | "waiting" | "failed" | "unavailable";

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
  column_samples: Record<string, string[]>;
  status_model?: StatusModelState;
};

export type ColumnReport = {
  column: string;
  filled: number;
  filled_share: number;
  valid: number;
  valid_share: number;
  distinct: number;
  wrong: number;
  adds_info: number;
  adds_info_share: number;
  verdicts: Record<Verdict, number>;
  verdict_text: string;
};

export type SignReport = {
  code: string;
  label: string;
  contacted: number;
  wrong: number;
  wrong_rate: number | null;
  lift: number | null;
  counted: boolean;
  measured_only: boolean;
  predictive: boolean;
  enough_data: boolean;
};

export type ReviewRow = { row_number: number; raw: Raw };
export type PhoneChoice = {
  number: string | null;
  raw: string;
  column: string;
  columns: string[];
  rank: number;
  extension?: string | null;
  valid_format: boolean;
  quality: Verdict;
  permission: "blocked_dnc" | "no_recorded_block";
  blocked: boolean;
  type: string | null;
  recommendation: string;
  explanations: string[];
  warnings: string[];
  last_success: string | null;
  shared: { kind: string; people: number; explanation: string };
  last_outcome: { outcome: string; occurred_at: string | null; source: string } | null;
  lookup: {
    provider: string;
    checked_at: string;
    stale: boolean;
    carrier: string | null;
    type: string | null;
    line_status: string;
    ownership_verified: false;
  } | null;
};
export type DuplicateRow = { row_number: number; keep: boolean; label: string };
/** What a check found about rows that repeat a lead (see callerwhale_matching/duplicates.py). */
export type DuplicateSummary = {
  groups: number;
  duplicate_rows: number;
  rows_in_groups: number;
  possible_rows: number;
  owner_groups: number;
  owner_rows: number;
  examples: { group: string; why: string; size: number; rows: DuplicateRow[] }[];
  owner_examples: { size: number; rows: DuplicateRow[] }[];
  compared_pairs: number;
  ignored_shared_values: number;
  /** Large groups of rows sharing one value, gone through by a second shared value and by nearest neighbours. */
  narrowed_groups: number;
  /** How many of the person's own answers this check followed. */
  overruled: number;
  has_names: boolean;
  has_address: boolean;
};
export type SkiptraceReport = {
  /** Absent in a check from before Caller Whale looked for repeated leads; null when the person turned it off. */
  duplicates?: DuplicateSummary | null;
  phone_assessments?: Record<string, number>;
  scan_job_id: string;
  fingerprint: string;
  checked_at: string;
  checked_date: string;
  manual_evidence: Record<string, { mark: ManualMark; at: string; until?: string | null; source?: string }>;
  row_counts: Record<string, number>;
  preview: ReviewRow[];
  added_columns: string[];
  rows: number;
  rows_with_phone: number;
  rows_with_callable_number: number;
  values: number;
  verdicts: Record<Verdict, number>;
  reasons: { code: string; label: string; count: number; effect: string; examples: { row: number; column: string; value: string; text: string }[] }[];
  columns: ColumnReport[];
  types: Record<string, number>;
  countries: Record<string, number>;
  repairs: { note: string; count: number }[];
  outcomes: {
    available: boolean;
    rows: Record<string, number>;
    baseline_wrong_rate: number | null;
    contacted: number;
    known_wrong_numbers: number;
    do_not_call_numbers: number;
    expired_do_not_call_numbers: number;
    carried_rows: number;
    carried_wrong_number: number;
    carried_do_not_call: number;
  };
  signals: SignReport[];
  metadata_version: string;
  other_datasets_used: string[];
};

export type AreaLevel = "state" | "city" | "zip";
export type AreaMapping = Partial<Record<AreaLevel, string>>;

/** A mark made by hand in Caller Whale, kept per phone number so it follows the number into every list. */
export type ManualMark = "called" | "wrong_number" | "do_not_call" | "interested";
