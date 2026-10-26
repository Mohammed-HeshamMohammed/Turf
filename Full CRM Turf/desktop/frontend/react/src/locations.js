import { coordinates, mappedRecord } from "./skiptrace-fields.js";

// Rounded city reference areas, never property coordinates or geocoded addresses.
const FLORIDA_AREAS = { tampa: [28, -82.5], orlando: [28.5, -81.4], clearwater: [28, -82.8], "st petersburg": [27.8, -82.6] };
const present = value =>
  value !== undefined && value !== null && String(value).trim() !== "" && !/^(?:address not supplied|unknown|n\/?a|none)$/i.test(String(value).trim());

export function recordLocation(row, dataset, overrides) {
  if (row.geo && Number.isFinite(row.geo.lat) && Number.isFinite(row.geo.lng)) {
    const address = [row.address, row.city, row.region, row.zip].filter(present).join(", ");
    return row.geo.precision === "address"
      ? { point: [row.geo.lat, row.geo.lng], kind: "coordinates", label: "Located by address", address, invalid: false }
      : { point: [row.geo.lat, row.geo.lng], kind: "area", label: "ZIP code area · approximate", address, invalid: false };
  }
  const data = row.sourceValues ? mappedRecord(dataset?.columns || Object.keys(row.sourceValues), row, { ...dataset?.fieldMappings, ...overrides }) : row;
  const point = coordinates(data.latitude ?? data.lat, data.longitude ?? data.lng ?? data.lon);
  const address = [data.address, data.unit, data.city, data.region, data.zip, data.country].filter(present).join(", ");
  const invalid = !point && (present(data.latitude ?? data.lat) || present(data.longitude ?? data.lng ?? data.lon));
  if (point) return { point, kind: "coordinates", label: "Supplied coordinates", address, invalid: false };
  const city = String(data.city || "")
    .toLowerCase()
    .replaceAll(".", "")
    .trim();
  const country = String(data.country || "").trim();
  const florida = /^(?:fl|florida)$/i.test(String(data.region || "")) && (!country || /^(?:us|usa|united states(?: of america)?)$/i.test(country));
  if (florida && Object.hasOwn(FLORIDA_AREAS, city))
    return { point: FLORIDA_AREAS[city], kind: "area", label: "Approximate city area", address, invalid: Boolean(invalid) };
  return {
    point: null,
    kind: address ? "address" : "missing",
    label: address ? "Address lookup needed" : "No location supplied",
    address,
    invalid: Boolean(invalid),
  };
}

export function mapSearchUrl(location) {
  const query = location.address || (location.point ? location.point.join(", ") : "");
  return query ? "https://www.openstreetmap.org/search?query=" + encodeURIComponent(query) : null;
}
