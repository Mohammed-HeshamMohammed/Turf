// Where rows go on the map. A row is placed, in order of preference, by its own latitude and longitude, by its exact
// address (once looked up), or at the centre of its ZIP code. The service knows the ZIP centres and does the lookups.

import { useEffect, useState } from "react";
import { call, runJob } from "./service";
import type { DatasetRow } from "./types";

export type ZipCentre = { lat: number; lon: number; states: string[] };
export type AddressColumns = { street: string; city?: string; state?: string; zip?: string };
export type Located = { exact: Record<string, [number, number]>; addresses_to_look_up: number; rows_without_an_address: number };
export type LocateProgress = { done: number; total: number; found: number };

export const locatedAddresses = (dataset_id: string, columns: AddressColumns) => call<Located>("geo.located", { dataset_id, columns });

/** Sends the list's addresses to the US Census geocoder. Only street, city, state and ZIP leave the computer. */
export const locateAddresses = (dataset_id: string, columns: AddressColumns, onProgress: (progress: LocateProgress) => void, onStart: (jobId: string) => void) =>
  runJob<{ looked_up: number; found: number; not_found: number }>("geo.locate", { dataset_id, columns }, {
    onStart,
    onEvent: payload => { if (payload.stage === "locating_addresses") onProgress(payload as unknown as LocateProgress); },
  });

export const cancelJob = (job_id: string) => call("job.cancel", { job_id });

/** The column holding the street address, found by its name only. */
export const streetColumn = (columns: string[]) =>
  columns.find(name => /^(street|address|street address|property address|site address|situs address|mailing address|address ?1|address line ?1)$/i.test(name.trim()));

// ZIP centres are the same for every list, so each ZIP is asked for once.
const centres = new Map<string, ZipCentre | null>();

/** The centres of the ZIP values given, as they arrive. Values the service does not know are simply absent. */
export function useZipCentres(values: string[], onError: (reason: unknown) => void) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const missing = values.filter(value => !centres.has(value));
    if (!missing.length) return;
    let current = true;
    call<Record<string, ZipCentre>>("geo.zip_centres", { zips: missing }).then(found => {
      for (const value of missing) centres.set(value, found[value] ?? null);
      if (current) redraw(count => count + 1);
    }, reason => current && onError(reason));
    return () => { current = false; };
  }, [values, onError]);
  return centres;
}

/** A placed row. `zip` is set when the place is its ZIP's centre, so rows of one ZIP can be drawn as one area. */
export type Outline = { type: string; coordinates: unknown };

// A ZIP's outline is the same for every list. The service keeps them on disk; this keeps them for the session.
const outlines = new Map<string, Outline | null>();
const OUTLINE_BATCH = 40;

/**
 * The outlines of the ZIP values given, arriving a batch at a time so the map fills in as they come.
 * Returns the store and how many outlines are in it for these values. A ZIP that could not be fetched (no
 * connection) is left out and asked for again next time.
 */
export function useZipOutlines(values: string[], onError: (reason: unknown) => void) {
  const [, redraw] = useState(0);
  useEffect(() => {
    const missing = values.filter(value => !outlines.has(value));
    if (!missing.length) return;
    let current = true;
    void (async () => {
      for (let start = 0; start < missing.length && current; start += OUTLINE_BATCH) {
        const batch = missing.slice(start, start + OUTLINE_BATCH);
        try {
          const found = await call<{ outlines: Record<string, Outline>; unavailable: number }>("geo.zip_outlines", { zips: batch });
          // With no connection nothing is remembered as missing, so the next look asks again.
          for (const value of batch) if (found.outlines[value] || !found.unavailable) outlines.set(value, found.outlines[value] ?? null);
          if (current) redraw(count => count + 1);
        } catch (reason) {
          if (current) onError(reason);
          return;
        }
      }
    })();
    return () => { current = false; };
  }, [values, onError]);
  return { outlines, count: values.filter(value => outlines.get(value)).length };
}

export type Placed = { lon: number; lat: number; rowId: string; zip?: string };
export type Placement = {
  dots: Placed[];
  /** Placed by the row's own coordinates, its exact address, or its ZIP centre. */
  own: number; exact: number; byZip: number;
  /** Not placed: the ZIP is not in the row's state, the ZIP is unknown, or there is no ZIP. */
  stateDisagrees: number; unknownZip: number; noZip: number;
};

/**
 * Places each row. A ZIP centre is used only when the ZIP lies in the row's state: a row whose ZIP and state disagree
 * has something wrong with it, and is left off the map and counted. A list with no state column is placed by ZIP alone.
 */
export function placeRows(rows: DatasetRow[], options: {
  position: { latitude: string; longitude: string } | null; zipColumn?: string; stateColumn?: string;
  centres: Map<string, ZipCentre | null>; exact?: Record<string, [number, number]>;
}): Placement {
  const placement: Placement = { dots: [], own: 0, exact: 0, byZip: 0, stateDisagrees: 0, unknownZip: 0, noZip: 0 };
  const { position, zipColumn, stateColumn, exact } = options;
  for (const row of rows) {
    if (position) {
      const lon = Number(row.raw[position.longitude]);
      const lat = Number(row.raw[position.latitude]);
      if (row.raw[position.longitude] !== null && row.raw[position.latitude] !== null && Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat)) {
        placement.dots.push({ lon, lat, rowId: row.id });
        placement.own += 1;
        continue;
      }
    }
    const found = exact?.[String(row.row_number)];
    if (found) {
      placement.dots.push({ lat: found[0], lon: found[1], rowId: row.id });
      placement.exact += 1;
      continue;
    }
    const zip = zipColumn ? String(row.raw[zipColumn] ?? "").trim() : "";
    if (!zip) { placement.noZip += 1; continue; }
    const centre = options.centres.get(zip);
    if (!centre) { placement.unknownZip += 1; continue; }
    const state = stateColumn ? String(row.raw[stateColumn] ?? "").trim().toUpperCase() : "";
    if (stateColumn && !centre.states.includes(state)) { placement.stateDisagrees += 1; continue; }
    placement.dots.push({ lat: centre.lat, lon: centre.lon, rowId: row.id, zip });
    placement.byZip += 1;
  }
  return placement;
}
