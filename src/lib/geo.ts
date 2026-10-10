// Where rows go on the map. A row is placed, in order of preference, by its own latitude and longitude, by its exact
// address (once looked up), or at the centre of its ZIP code. The service knows the ZIP centres and does the lookups.

import { useEffect, useState } from "react";
import { call, runJob } from "./service";
import type { Dot } from "../components/AreaMap";
import type { Group, Spot } from "../components/StreetMap";
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

/**
 * A placed row. `exact` is set when the place is the row's own (its coordinates, or its address once looked up) rather
 * than the centre of its ZIP. `zip` is the row's ZIP whenever it has one, so the rows of a ZIP are counted together
 * however they were placed.
 */
export type Placed = { lon: number; lat: number; rowId: string; zip?: string; label?: string; exact?: boolean };
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
  /** The column holding the street address, which names the rows that have a place of their own. */
  streetColumn?: string;
}): Placement {
  const placement: Placement = { dots: [], own: 0, exact: 0, byZip: 0, stateDisagrees: 0, unknownZip: 0, noZip: 0 };
  const { position, zipColumn, stateColumn, exact } = options;
  const labelOf = (row: DatasetRow) => (options.streetColumn ? String(row.raw[options.streetColumn] ?? "").trim() || undefined : undefined);
  for (const row of rows) {
    const zip = zipColumn ? String(row.raw[zipColumn] ?? "").trim() : "";
    if (position) {
      const lon = Number(row.raw[position.longitude]);
      const lat = Number(row.raw[position.latitude]);
      if (row.raw[position.longitude] !== null && row.raw[position.latitude] !== null && Number.isFinite(lon) && Number.isFinite(lat) && (lon || lat)) {
        placement.dots.push({ lon, lat, rowId: row.id, zip: zip || undefined, label: labelOf(row), exact: true });
        placement.own += 1;
        continue;
      }
    }
    const found = exact?.[String(row.row_number)];
    if (found) {
      placement.dots.push({ lat: found[0], lon: found[1], rowId: row.id, zip: zip || undefined, label: labelOf(row), exact: true });
      placement.exact += 1;
      continue;
    }
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

export type MapSource = {
  rows: DatasetRow[]; dots: Placed[];
  /** The columns of this list that name each level, and the one the Areas card is on. */
  columns: { zip?: string; city?: string; state?: string }; named?: string;
  /** The rows the filters show; every row when absent. */
  kept?: Set<string>;
};

/**
 * Gathers placed rows for the map at every level it draws: each property that has a place of its own (`points`), the
 * rows of each ZIP (`spots`, counting every row in it however it was placed, and how many are not on their own address
 * yet), and the same rows again by city and by state. The counts at each level add up to the level below.
 */
export function gatherForMap(sources: MapSource[], centres: Map<string, ZipCentre | null>) {
  const spots = new Map<string, Spot>();
  const points: Dot[] = [];
  type Sum = Group & { n: number };
  const cities = new Map<string, Sum>();
  const states = new Map<string, Sum>();
  const add = (groups: Map<string, Sum>, key: string, name: string, dot: Placed, shown: boolean) => {
    let group = groups.get(key);
    if (!group) groups.set(key, group = { name, lat: 0, lon: 0, shown: 0, hidden: 0, n: 0 });
    group.lat += dot.lat; group.lon += dot.lon; group.n += 1;
    if (shown) group.shown += 1; else group.hidden += 1;
  };
  for (const source of sources) {
    const rowsById = new Map(source.rows.map(row => [row.id, row]));
    for (const dot of source.dots) {
      const row = rowsById.get(dot.rowId);
      const shown = source.kept ? source.kept.has(dot.rowId) : true;
      if (dot.exact) points.push({ lon: dot.lon, lat: dot.lat, dim: !shown, label: dot.label });
      if (dot.zip) {
        let spot = spots.get(dot.zip);
        if (!spot) {
          const centre = centres.get(dot.zip);
          const named = source.named ? String(row?.raw[source.named] ?? "").trim() : "";
          spots.set(dot.zip, spot = { zip: dot.zip, lat: centre?.lat ?? dot.lat, lon: centre?.lon ?? dot.lon, shown: 0, hidden: 0, loose: 0, area: named || dot.zip });
        }
        if (shown) spot.shown += 1; else spot.hidden += 1;
        if (shown && !dot.exact) spot.loose += 1;
      }
      const city = source.columns.city ? String(row?.raw[source.columns.city] ?? "").trim() : "";
      const state = source.columns.state ? String(row?.raw[source.columns.state] ?? "").trim().toUpperCase() : "";
      if (city) add(cities, `${state}|${city.toLowerCase()}`, state ? `${city}, ${state}` : city, dot, shown);
      if (state) add(states, state, state, dot, shown);
    }
  }
  const mean = (groups: Map<string, Sum>): Group[] => [...groups.values()].map(({ n, lat, lon, ...rest }) => ({ ...rest, lat: lat / n, lon: lon / n }));
  return { spots: [...spots.values()], points, zips: [...spots.keys()], cities: mean(cities), states: mean(states) };
}
