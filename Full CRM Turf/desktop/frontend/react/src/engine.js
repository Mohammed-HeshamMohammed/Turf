// Caller Whale's Skip Tracing engine (../service, Python) as the CRM uses it. The desktop window reaches it through the Tauri
// host (src-tauri/src/sidecar.rs); a browser tab on the dev server through /rpc (scripts/service-bridge.mjs). Where
// neither exists, for instance the hosted demo, `engineAvailable` answers false and the page keeps its demo check.
import { phoneColumns, sourceValue } from "./skiptrace-fields.js";

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const inDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function unwrap(envelope) {
  if (!envelope || envelope.schema_version !== 1 || typeof envelope.ok !== "boolean")
    throw new EngineError("invalid_response", "The Skip Tracing engine returned an unexpected response");
  if (!envelope.ok) throw new EngineError(envelope.error.code, envelope.error.message);
  return envelope.result;
}

export async function call(command, payload = {}) {
  if (inDesktop) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      return unwrap(await invoke("service_call", { command, payload }));
    } catch (reason) {
      throw reason instanceof Error ? reason : new EngineError("bridge_unavailable", String(reason));
    }
  }
  let response;
  try {
    response = await fetch("/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schema_version: 1, command, payload }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new EngineError("bridge_unavailable", "The Skip Tracing engine is not answering.");
  }
  if (!response.ok) throw new EngineError("bridge_unavailable", "The Skip Tracing engine is not available here.");
  return unwrap(await response.json());
}

let available;
/** Whether the engine can be reached. Asked once per page load. */
export function engineAvailable() {
  available ??= call("health.check").then(
    () => true,
    () => false,
  );
  return available;
}

/** Follows a job until it ends. `onEvent` gets each stage event, `onStart` the job id (cancelling needs it). */
export async function watchJob(jobId, { onEvent, signal } = {}) {
  let seen = 0;
  for (;;) {
    const job = await call("job.get", { job_id: jobId, after_event_id: seen });
    for (const event of job.events ?? []) {
      seen = Math.max(seen, event.id);
      onEvent?.(event.payload);
    }
    if (job.state === "completed" && job.result) return job.result;
    if (["completed", "failed", "cancelled"].includes(job.state)) throw new EngineError("job_" + job.state, job.error ?? "The check was " + job.state);
    if (signal?.aborted) throw new EngineError("job_cancelled", "The check was cancelled");
    await new Promise(resolve => setTimeout(resolve, 400));
  }
}

export const cancelJob = jobId => call("job.cancel", { job_id: jobId });

const WORKSPACE = "turf-crm";

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** The rows exactly as the source has them, as a CSV file in base64 (UTF-8). Row n of `rows` is engine row n + 2. */
export function sourceCsv(columns, rows) {
  const text = [columns, ...rows.map(row => columns.map(column => sourceValue(row, column)))].map(line => line.map(csvCell).join(",")).join("\r\n");
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** The CRM's field mapping as the engine's setup. Phone columns: the mapped one first, then any other populated one. */
export function engineConfig(suggested, columns, rows, mappings, { region = "US", findDuplicates = true, outcomes = null } = {}) {
  const populated = column => rows.some(row => sourceValue(row, column));
  const phones = [mappings.phone, ...phoneColumns(columns, rows)].filter(
    (column, index, all) => column && columns.includes(column) && populated(column) && all.indexOf(column) === index,
  );
  const pick = id => (columns.includes(mappings[id]) ? mappings[id] : null);
  const config = {
    ...suggested,
    phone_columns: phones,
    region,
    name_column: pick("name") ?? suggested.name_column ?? null,
    first_name_column: pick("firstName") ?? suggested.first_name_column ?? null,
    last_name_column: pick("lastName") ?? suggested.last_name_column ?? null,
    address_column: pick("address") ?? suggested.address_column ?? null,
    city_column: pick("city") ?? suggested.city_column ?? null,
    state_column: pick("region") ?? suggested.state_column ?? null,
    zip_column: pick("zip") ?? suggested.zip_column ?? null,
    mailing_address_column: pick("mailingAddress"),
    // Another parcel is another property, whoever owns it.
    parcel_column: pick("parcel"),
    // What the owner looks like: absentee, out of state, vacant, investor, years owned.
    mailing_city_column: pick("mailingCity"),
    mailing_state_column: pick("mailingRegion"),
    mailing_zip_column: pick("mailingZip"),
    owner_type_column: pick("ownerType"),
    owner_occupied_column: pick("ownerOccupied"),
    vacant_column: pick("vacant"),
    ownership_months_column: pick("ownershipMonths"),
    find_duplicates: findDuplicates,
    outcome: null,
  };
  if (outcomes && columns.includes(outcomes.column) && phones.length) config.outcome = { column: outcomes.column, called_column: phones[0], map: outcomes.map };
  return config;
}

/** One checked row as the CRM shows it. Blocked numbers stay blocked; a repeat is only named when nothing blocks it. */
export function crmVerdict(raw) {
  const why = Object.keys(raw)
    .filter(key => key.endsWith(" (why)"))
    .map(key => raw[key])
    .join("; ");
  const verdicts = Object.keys(raw)
    .filter(key => key.endsWith(" (verdict)"))
    .map(key => raw[key])
    .filter(Boolean);
  if (!verdicts.length) return "No phone";
  const permission = String(raw["Best phone permission"] || "");
  if (/do not call|dnc/i.test(permission + " " + why) && !raw["Best phone"]) return "Do not call";
  if (!raw["Best phone"]) return "Wrong number";
  if (String(raw["Duplicate status"] || "").startsWith("Duplicate") || String(raw["Duplicate status"] || "").startsWith("Possible"))
    return "Possible duplicate";
  if (raw["Best phone verdict"] === "corroborated" && !raw["Phone evidence warnings"]) return "Ready to call";
  if (raw["Best phone verdict"] === "suspicious" || raw["Phone evidence warnings"]) return "Needs review";
  return "Unverified";
}

/** Imports the rows into the CRM's engine workspace once per distinct content; the same rows are not imported twice. */
const imported = new Map();
async function importRows(name, columns, rows) {
  await call("project.open_workspace", { name: WORKSPACE });
  const data = sourceCsv(columns, rows);
  const key = name + "\n" + data;
  if (imported.has(key)) return imported.get(key);
  const file =
    name
      .replace(/[^\w .-]+/g, " ")
      .trim()
      .slice(0, 80) + ".csv";
  const { job_id } = await call("dataset.import_content", { name: file || "list.csv", data, allow_duplicate: true });
  const { dataset_id } = await watchJob(job_id);
  imported.set(key, dataset_id);
  return dataset_id;
}

/** Imports the list and reads the engine's proposed setup and the meaning of each imported call status. */
export async function prepare({ name, columns, rows, outcomeColumn }) {
  const datasetId = await importRows(name, columns, rows);
  const suggestion = await call("skiptrace.suggest", { dataset_id: datasetId });
  const statuses = outcomeColumn ? await call("skiptrace.statuses", { dataset_id: datasetId, column: outcomeColumn }) : [];
  return { datasetId, suggestion, statuses };
}

/**
 * Runs the check. Answers the report and one result per input row, in order: { verdict, bestPhone, why, duplicate }.
 * `onStage` gets { stage, completed, total }; `onStart` the job id.
 */
export async function check({ datasetId, config, onStage, onStart, signal }) {
  const saved = await call("skiptrace.save_settings", { dataset_id: datasetId, config });
  const { job_id } = await call("skiptrace.scan", { dataset_id: datasetId, config: saved });
  onStart?.(job_id);
  const { report } = await watchJob(job_id, { onEvent: event => onStage?.(event), signal });
  const results = [];
  for (let offset = 0; offset < report.row_counts.all; offset += 100) {
    const page = await call("skiptrace.review", { job_id, filter: "all", offset, limit: 100 });
    for (const row of page.rows)
      results[row.row_number - 2] = {
        verdict: crmVerdict(row.raw),
        bestPhone: row.raw["Best phone"] || "",
        why: row.raw["Best phone why"] || row.raw[saved.phone_columns[0] + " (why)"] || "",
        duplicate: row.raw["Duplicate status"] || "",
        raw: row.raw,
      };
  }
  return { jobId: job_id, config: saved, report, results };
}

/** Saves the checked copy in the engine's workspace. The source list is never changed. */
export async function saveCopy({ datasetId, config, jobId, name }) {
  const { job_id } = await call("skiptrace.apply", { dataset_id: datasetId, config, name, scan_job_id: jobId });
  return watchJob(job_id);
}

/**
 * A list without phone numbers: finds the rows that repeat the same lead from owner names and addresses (the same
 * engine and rules as a phone check). Answers one result per input row, in order: { verdict, why, duplicate }.
 */
export async function checkRepeats({ datasetId, config, onStage, onStart, signal }) {
  const { job_id } = await call("skiptrace.repeats", { dataset_id: datasetId, config });
  onStart?.(job_id);
  const found = await watchJob(job_id, { onEvent: event => onStage?.(event), signal });
  const results = [];
  for (const item of found.results) {
    const repeat = item.status.startsWith("Duplicate") || item.status.startsWith("Possible");
    results[item.row_number - 2] = {
      verdict: repeat ? "Possible duplicate" : item.government ? "Not a lead" : "No phone",
      why: repeat
        ? item.why || item.status
        : item.government
          ? "Government owner: not a lead"
          : item.same_owner
            ? "Same owner as " + item.same_owner.replace(/^Rows?/, word => word.toLowerCase()) + " of the list · a different property"
            : "No phone number in this list",
      duplicate: item.status,
      sameOwner: item.same_owner || "",
      bestPhone: "",
      owner: item.owner || "",
      properties: item.properties || 1,
      addresses: item.addresses || "",
      absentee: Boolean(item.absentee),
      outOfState: Boolean(item.out_of_state),
      vacant: Boolean(item.vacant),
      government: Boolean(item.government),
      score: item.score ?? 0,
      reasons: item.reasons || [],
    };
  }
  return {
    jobId: job_id,
    report: null,
    repeats: found.repeats,
    sameOwner: found.same_owner || 0,
    owners: found.owners || 0,
    absentee: found.absentee || 0,
    outOfState: found.out_of_state || 0,
    vacant: found.vacant || 0,
    government: found.government || 0,
    results,
  };
}

// ---- Placing leads on the map ----------------------------------------------------------------------------------
// Two steps, both from the US Census Bureau through Caller Whale's engine (service/turf_service/geo.py):
//   1. the centre of each lead's ZIP code, from a file shipped with Caller Whale: instant and offline, an approximate place;
//   2. the exact address, from the Bureau's public geocoder: street, city, state and ZIP are sent (never names or
//      phone numbers), only when the person asks, and every answer is remembered so nothing is looked up twice.

const STATE_CODES = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "puerto rico": "PR",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};
export const stateCode = value => {
  const text = String(value ?? "").trim();
  return /^[a-z]{2}$/i.test(text) ? text.toUpperCase() : STATE_CODES[text.toLowerCase()] || "";
};
const street = lead => (/^address not supplied$/i.test(String(lead.address || "").trim()) ? "" : String(lead.address || "").trim());

/** Whether a lead has enough of an address to look up: a street, and a ZIP or a city and state. */
export const locatable = lead => Boolean(street(lead) && (lead.zip || (lead.city && stateCode(lead.region))));

/** Approximate places at once: each lead's ZIP centre ({ leadId: { lat, lng, precision: "zip" } }). */
export async function zipPlaces(leads) {
  const zips = [...new Set(leads.map(lead => String(lead.zip || "").trim()).filter(Boolean))];
  if (!zips.length) return {};
  const centres = await call("geo.zip_centres", { zips });
  const places = {};
  for (const lead of leads) {
    const centre = centres[String(lead.zip || "").trim()];
    const state = stateCode(lead.region);
    // A ZIP in another state than the lead says is a typo somewhere: no place rather than a wrong one.
    if (centre && (!state || centre.states.includes(state))) places[lead.id] = { lat: centre.lat, lng: centre.lon, precision: "zip" };
  }
  return places;
}

/**
 * Exact places for leads' addresses. Answers { places: { leadId: { lat, lng, precision: "address" } }, notFound: [leadId] }.
 * `onStage` gets { done, total, found } as batches come back.
 */
export async function locateAddresses(leads, { onStage, signal } = {}) {
  const asked = leads.filter(locatable);
  if (!asked.length) return { places: {}, notFound: [] };
  const columns = ["Street", "City", "State", "Zip"];
  const rows = asked.map(lead => ({
    sourceValues: { Street: street(lead), City: String(lead.city || "").trim(), State: stateCode(lead.region), Zip: String(lead.zip || "").trim() },
  }));
  const datasetId = await importRows("Addresses to locate", columns, rows);
  const roles = { street: "Street", city: "City", state: "State", zip: "Zip" };
  const { job_id } = await call("geo.locate", { dataset_id: datasetId, columns: roles });
  await watchJob(job_id, { onEvent: onStage, signal });
  const found = await call("geo.located", { dataset_id: datasetId, columns: roles });
  const places = {};
  for (const [rowNumber, point] of Object.entries(found.exact)) {
    const lead = asked[Number(rowNumber) - 2];
    if (lead) places[lead.id] = { lat: point[0], lng: point[1], precision: "address" };
  }
  return { places, notFound: found.not_found.map(rowNumber => asked[rowNumber - 2]?.id).filter(Boolean) };
}
