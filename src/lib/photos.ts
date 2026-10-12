import { streetColumn } from "./geo";
import { areaColumns, ownColumns, positionColumns } from "./marks";
import type { AreaMapping, DatasetRow } from "./types";

// Pictures of a property, wherever a list keeps them: a link, several links in one cell, an <img> tag, an Excel
// =IMAGE("...") formula, or the picture itself written into the cell (which the service hands over as a
// "turf-image:" reference). A row without its own picture can borrow one from another list in the project that has the
// same property, matched by address or by position.

export const EMBEDDED = "turf-image:";
const IMAGE_FILE = /\.(jpe?g|png|gif|webp|avif|bmp)(?:[?#]|$)/i;
// Hosts that serve listing photos without a file ending.
const PHOTO_HOSTS = /(^|\.)(photos\.zillowstatic\.com|ssl\.cdn-redfin\.com|ap\.rdcpix\.com|cdn\.realtor\.com|images\.homes\.com|photos\.harstatic\.com|img\.trulia\.com|lh3\.googleusercontent\.com)$/i;
const NAME_HINT = /image|photo|picture|thumb|img|pic\b/i;

function pictureLink(text: string): string | null {
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;  // never javascript:, file: or data: links
  return IMAGE_FILE.test(url.pathname) || PHOTO_HOSTS.test(url.hostname) ? url.href : null;
}

/** Every picture in a cell, in order, without repeats. */
export function photosIn(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const text = String(value).trim();
  if (!text) return [];
  const found: string[] = [];
  for (const token of text.match(/turf-image:[0-9a-f]{32}\.(?:png|jpg|gif|webp)/g) ?? []) found.push(token);
  // <img src="..."> and =IMAGE("...") carry their link inside quotes
  for (const match of text.matchAll(/(?:src\s*=\s*|IMAGE\(\s*)["']([^"']+)["']/gi)) {
    const link = pictureLink(match[1]);
    if (link) found.push(link);
  }
  for (const part of text.split(/[\s,|;"'<>()]+/)) {
    const link = part.startsWith("http") ? pictureLink(part) : null;
    if (link) found.push(link);
  }
  return [...new Set(found)];
}

/** The columns that hold pictures: most of their filled cells have one (or, with a picture-like name, a good share). */
export function photoColumns(rows: DatasetRow[], columns: string[]): string[] {
  const sample = rows.slice(0, 200);
  const scored = ownColumns(columns).map(name => {
    const filled = sample.filter(row => String(row.raw[name] ?? "").trim());
    const withPhotos = filled.filter(row => photosIn(row.raw[name]).length).length;
    const share = filled.length ? withPhotos / filled.length : 0;
    const multiple = filled.some(row => photosIn(row.raw[name]).length > 1);
    return { name, share, multiple, keep: withPhotos > 0 && (share >= 0.6 || (NAME_HINT.test(name) && share >= 0.3)) };
  });
  // a single picture first (usually the cover), then columns holding several
  return scored.filter(item => item.keep).sort((a, b) => Number(a.multiple) - Number(b.multiple)).map(item => item.name);
}

export function photosOfRow(row: DatasetRow, columns: string[]): string[] {
  return [...new Set(columns.flatMap(column => photosIn(row.raw[column])))];
}

// ------------------------------------------------------------------------------------------- the same property

const STREET_WORDS: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", drive: "dr", road: "rd", lane: "ln", court: "ct", boulevard: "blvd", place: "pl",
  terrace: "ter", circle: "cir", parkway: "pkwy", highway: "hwy", trail: "trl", square: "sq", way: "way", point: "pt",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  apartment: "apt", suite: "ste", unit: "unit", number: "#",
};

const UNIT = /^\s*(unit|apt|apartment|suite|ste|#|bldg|building|lot|fl|floor)\b/i;

/** The street part of an address as written, with a unit after a comma, without the city and state that follow. */
export function streetPart(value: unknown): string {
  const parts = String(value ?? "").split(",");
  const unitAt = parts.findIndex((part, index) => index > 0 && !UNIT.test(part));
  return parts.slice(0, unitAt === -1 ? parts.length : unitAt).map(part => part.trim()).filter(Boolean).join(", ");
}

/** A street address in one spelling: "2505 Hazard Street, Unit B" and "2505 hazard st unit b" are the same. */
export function streetKey(value: unknown): string {
  return streetPart(value).toLowerCase().replace(/[.#,]/g, " ").split(/\s+/).filter(Boolean).map(word => STREET_WORDS[word] ?? word).join(" ");
}

export type PlaceColumns = { street?: string; zip?: string; city?: string; position: { latitude: string; longitude: string } | null };

export function placeColumns(columns: string[], saved?: AreaMapping): PlaceColumns {
  const own = ownColumns(columns);
  const areas = areaColumns(columns, saved);
  return { street: streetColumn(own), zip: areas.zip, city: areas.city, position: positionColumns(own) };
}

/** Keys that name a property: its street with its ZIP (or city), and its position to about ten metres. */
export function placeKeys(row: DatasetRow, columns: PlaceColumns, exact?: [number, number]): string[] {
  const keys: string[] = [];
  const street = columns.street ? streetKey(row.raw[columns.street]) : "";
  if (street && /\d/.test(street)) {
    const zip = columns.zip ? String(row.raw[columns.zip] ?? "").trim().slice(0, 5) : "";
    const city = columns.city ? String(row.raw[columns.city] ?? "").trim().toLowerCase() : "";
    if (zip) keys.push(`a:${street}|${zip}`);
    if (city) keys.push(`c:${street}|${city}`);
  }
  const position = columns.position ? [Number(row.raw[columns.position.latitude]), Number(row.raw[columns.position.longitude])] as [number, number] : exact;
  if (position && Number.isFinite(position[0]) && Number.isFinite(position[1]) && (position[0] || position[1])) keys.push(`p:${position[0].toFixed(4)},${position[1].toFixed(4)}`);
  return keys;
}

export type PhotoIndex = Map<string, string[]>;

/** The pictures of every property in the lists that have pictures, under each of its place keys. */
export function photoIndex(lists: { rows: DatasetRow[]; columns: string[]; saved?: AreaMapping }[]): PhotoIndex {
  const index: PhotoIndex = new Map();
  for (const list of lists) {
    const pictures = photoColumns(list.rows, list.columns);
    if (!pictures.length) continue;
    const place = placeColumns(list.columns, list.saved);
    for (const row of list.rows) {
      const photos = photosOfRow(row, pictures);
      if (!photos.length) continue;
      for (const key of placeKeys(row, place)) if (!index.has(key)) index.set(key, photos);
    }
  }
  return index;
}

/** A row's pictures: its own first, else those of the same property in another list. */
export function photosFor(row: DatasetRow, own: string[], place: PlaceColumns, index: PhotoIndex, exact?: [number, number]): { photos: string[]; borrowed: boolean } {
  const photos = photosOfRow(row, own);
  if (photos.length) return { photos, borrowed: false };
  for (const key of placeKeys(row, place, exact)) {
    const found = index.get(key);
    if (found) return { photos: found, borrowed: true };
  }
  return { photos: [], borrowed: false };
}

/** Where a row is on the map, for the aerial view: its own position, else its looked-up address. */
export function positionOf(row: DatasetRow, place: PlaceColumns, exact?: [number, number]): [number, number] | null {
  if (place.position) {
    const lat = Number(row.raw[place.position.latitude]), lon = Number(row.raw[place.position.longitude]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) return [lat, lon];
  }
  return exact ?? null;
}
