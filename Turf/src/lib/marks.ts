import type { AreaLevel, AreaMapping, DatasetRow, ManualMark, Raw, Verdict } from "./types";

const RANK: Record<Verdict, number> = { corroborated: 0, unverified: 1, suspicious: 2, wrong: 3 };
const isVerdict = (value: unknown): value is Verdict => typeof value === "string" && value in RANK;

/** Columns Skip Tracing adds to a checked copy; everything else is the list's own data. */
export const isAddedColumn = (name: string) =>
  /\((verdict|why|E\.164|type|quality|permission)\)$/.test(name) ||
  name.startsWith("Best phone") ||
  ["Phone choices", "Phone evidence warnings", "Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows"].includes(name);

export const ownColumns = (columns: string[]) => columns.filter(name => !isAddedColumn(name));

export const checkedPhoneColumns = (columns: string[]) => columns.filter(name => name.endsWith(" (verdict)")).map(name => name.slice(0, -" (verdict)".length));

export type Marks = {
  verdict: Verdict | null;
  best: string | null;
  bestFrom: string | null;
  why: string | null;
  knownWrong: boolean;
  doNotCall: boolean;
  doNotCallUntil: string | null;
  /** The number a manual mark attaches to: the best phone, else the first number read. */
  number: string | null;
  manual: ManualMark | null;
};

export type ManualMarks = Record<string, { mark: ManualMark; at: string; until?: string | null; source?: string }>;

/** Reads a row's marks from the checked copy's columns, then lays any manual mark for its number on top. */
export function readMarks(raw: Raw, phoneColumns: string[], manual: ManualMarks): Marks {
  let verdict: Verdict | null = isVerdict(raw["Best phone verdict"]) ? raw["Best phone verdict"] : null;
  let bestFrom = raw["Best phone from"] ? String(raw["Best phone from"]) : null;
  const best = raw["Best phone"] ? String(raw["Best phone"]) : null;
  let knownWrong = false;
  let doNotCall = false;
  let doNotCallUntil: string | null = null;
  let firstNumber: string | null = null;
  for (const column of phoneColumns) {
    const columnVerdict = raw[`${column} (verdict)`];
    if (isVerdict(columnVerdict) && (!verdict || (!raw["Best phone verdict"] && RANK[columnVerdict] < RANK[verdict]))) {
      verdict = columnVerdict;
      bestFrom = raw["Best phone from"] ? bestFrom : column;
    }
    firstNumber = firstNumber ?? (raw[`${column} (E.164)`] ? String(raw[`${column} (E.164)`]) : null);
    const why = String(raw[`${column} (why)`] ?? "");
    // The reason texts Skip Tracing writes: "Marked wrong number in …" and "Do not call: on a do-not-call list in … until …".
    if (/marked wrong number (in|\d)/i.test(why) && !/but reached/i.test(why)) knownWrong = true;
    if (/do not call: on a do-not-call list/i.test(why)) {
      doNotCall = true;
      doNotCallUntil = why.match(/until (\d{4}-\d{2}-\d{2})/)?.[1] ?? doNotCallUntil;
    }
  }
  let why = raw["Best phone why"] ? String(raw["Best phone why"]) : bestFrom && raw[`${bestFrom} (why)`] ? String(raw[`${bestFrom} (why)`]) : null;
  const number = (best ?? firstNumber)?.split(";")[0].trim() ?? null;
  const entry = number ? manual[number] : undefined;
  const today = [new Date().getFullYear(), String(new Date().getMonth() + 1).padStart(2, "0"), String(new Date().getDate()).padStart(2, "0")].join("-");
  const mark = entry?.mark === "do_not_call" && entry.until && entry.until < today ? null : (entry?.mark ?? null);
  if (mark === "wrong_number") {
    verdict = verdict === "corroborated" || /but reached/i.test(why ?? "") ? "suspicious" : "wrong";
    knownWrong = verdict === "wrong";
    why = verdict === "suspicious" ? "Conflicting outcomes: marked wrong in Turf, but a person was reached" : "Marked a wrong number in Turf";
  }
  if (mark === "do_not_call") {
    verdict = "wrong";
    doNotCall = true;
    doNotCallUntil = entry?.until ?? null;
    why = "Marked do-not-call in Turf";
  }
  if (mark === "interested" && verdict !== "wrong") {
    verdict = "corroborated";
    why = "Marked interested in Turf: a call reached a person";
  }
  const separatelyUsable = raw["Best phone quality"] && raw["Best phone quality"] !== "wrong" && raw["Best phone permission"] === "no_recorded_block";
  const blockedByNewMark = mark === "do_not_call" || (mark === "wrong_number" && verdict === "wrong");
  return {
    verdict,
    best: blockedByNewMark ? null : separatelyUsable ? best : verdict === "wrong" ? null : best,
    bestFrom,
    why,
    knownWrong,
    doNotCall,
    doNotCallUntil,
    number,
    manual: mark,
  };
}

// ---------------------------------------------------------------- areas

const AREA_PATTERNS: Record<AreaLevel, RegExp> = {
  state: /^(state|st|province)$|state$/i,
  city: /^(city|town)$|city$/i,
  zip: /^(zip|zip ?code|postal ?code|postcode)$/i,
};

export const AREA_LEVELS: AreaLevel[] = ["state", "city", "zip"];
export const AREA_LABELS: Record<AreaLevel, string> = { state: "State", city: "City", zip: "ZIP" };

/** Finds area columns by their name only. A list with none is reported, never guessed from values. */
export function areaColumns(columns: string[], saved: AreaMapping | undefined): AreaMapping {
  const own = ownColumns(columns);
  const found: AreaMapping = {};
  for (const level of AREA_LEVELS) {
    const savedColumn = saved?.[level];
    found[level] = savedColumn && own.includes(savedColumn) ? savedColumn : own.find(name => AREA_PATTERNS[level].test(name.trim()));
  }
  return found;
}

export function countAreas(rows: DatasetRow[], column: string | undefined) {
  if (!column) return [];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = String(row.raw[column] ?? "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function positionColumns(columns: string[]) {
  const latitude = columns.find(name => /^lat(itude)?$/i.test(name));
  const longitude = columns.find(name => /^(lon|lng|long|longitude)$/i.test(name));
  return latitude && longitude ? { latitude, longitude } : null;
}

// ---------------------------------------------------------------- formatting

export const VERDICT_LABELS: Record<Verdict, string> = { corroborated: "Corroborated", unverified: "Unverified", suspicious: "Suspicious", wrong: "Wrong" };
export const MANUAL_MARKS: ManualMark[] = ["called", "interested", "wrong_number", "do_not_call"];
export const MANUAL_LABELS: Record<ManualMark, string> = {
  called: "Called",
  wrong_number: "Wrong number",
  do_not_call: "Do not call",
  interested: "Interested",
};
export const KIND_LABELS = {
  import: "Imported file",
  scrape: "Collected run",
  cleaned: "Cleaned copy",
  checked: "Checked copy",
  combined: "Combined list",
} as const;

export function formatPhone(e164: string | null) {
  const match = e164?.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : (e164 ?? "");
}

export const formatNumber = (value: number) => value.toLocaleString("en-US");
export const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
