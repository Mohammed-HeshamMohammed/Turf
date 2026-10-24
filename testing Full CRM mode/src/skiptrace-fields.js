export const EVIDENCE_FIELDS = [
  {
    id: "phone",
    label: "Phone",
    property: "phone",
    aliases: /^(?:(?:owner|primary|best|contact)(?: \d+)? )?(?:phone|telephone|mobile|cell)(?: (?:number|no))?(?: \d+)?$/,
  },
  {
    id: "address",
    label: "Address",
    property: "address",
    aliases: /^(?:(?:property|site|situs) )?(?:street )?(?:address|street)(?: (?:line )?1)?$/,
  },
  { id: "email", label: "Email", property: "email", aliases: /^(?:(?:owner|primary|contact) )?e ?mail(?: address)?$/ },
  { id: "name", label: "Owner name", property: "name", aliases: /^(?:(?:owner|full|contact|seller) )?name$|^owner$/ },
];

export const SOURCE_FIELDS = [
  ...EVIDENCE_FIELDS.map(field => ({ ...field, group: "Contact & identity" })),
  { id: "firstName", label: "First name", property: "firstName", group: "Contact & identity", aliases: /^(?:owner |contact )?first name$/ },
  { id: "lastName", label: "Last name", property: "lastName", group: "Contact & identity", aliases: /^(?:owner |contact )?(?:last name|surname)$/ },
  {
    id: "unit",
    label: "Unit / address line 2",
    property: "unit",
    group: "Property & location",
    aliases: /^(?:unit|apartment|apt|suite|(?:property |street )?address (?:line )?2)$/,
  },
  {
    id: "streetNumber",
    label: "Street number",
    property: "streetNumber",
    group: "Property & location",
    aliases: /^(?:(?:property|site) )?(?:street|house) (?:number|no)$/,
  },
  { id: "streetName", label: "Street name", property: "streetName", group: "Property & location", aliases: /^(?:property )?street name$/ },
  { id: "city", label: "City", property: "city", group: "Property & location", aliases: /^(?:(?:property|site|situs) )?(?:city|town)$/ },
  {
    id: "region",
    label: "State / region",
    property: "region",
    group: "Property & location",
    aliases: /^(?:(?:property|site|situs) )?(?:state|region|province)(?: code)?$/,
  },
  {
    id: "zip",
    label: "ZIP / postal code",
    property: "zip",
    group: "Property & location",
    aliases: /^(?:property )?(?:zip(?: code)?|postal(?: code)?|postcode)$/,
  },
  { id: "country", label: "Country", property: "country", group: "Property & location", aliases: /^(?:property )?country(?: code)?$/ },
  { id: "county", label: "County", property: "county", group: "Property & location", aliases: /^(?:property )?county$/ },
  { id: "latitude", label: "Latitude", property: "latitude", group: "Property & location", aliases: /^(?:property )?(?:latitude|lat)$/ },
  { id: "longitude", label: "Longitude", property: "longitude", group: "Property & location", aliases: /^(?:property )?(?:longitude|lon|lng|long)$/ },
  { id: "parcel", label: "Parcel / APN", property: "parcel", group: "Property & location", aliases: /^(?:parcel(?: id| number)?|apn)$/ },
  { id: "mailingAddress", label: "Mailing address", property: "mailingAddress", group: "Mailing & evidence", aliases: /^(?:owner )?mailing address$/ },
  { id: "mailingCity", label: "Mailing city", property: "mailingCity", group: "Mailing & evidence", aliases: /^(?:owner )?mailing city$/ },
  {
    id: "mailingRegion",
    label: "Mailing state / region",
    property: "mailingRegion",
    group: "Mailing & evidence",
    aliases: /^(?:owner )?mailing (?:state|region|province)$/,
  },
  {
    id: "mailingZip",
    label: "Mailing ZIP / postal code",
    property: "mailingZip",
    group: "Mailing & evidence",
    aliases: /^(?:owner )?mailing (?:zip(?: code)?|postal code|postcode)$/,
  },
  {
    id: "outcome",
    label: "Imported call outcome",
    property: "outcome",
    group: "Mailing & evidence",
    aliases: /^(?:call (?:status|outcome|result)|phone status|disposition)$/,
  },
  { id: "value", label: "Property value", property: "value", group: "Mailing & evidence", aliases: /^(?:(?:property|estimated) )?(?:value|price)$/ },
];

const normalize = column =>
  column
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function sourceValue(row, column) {
  if (row.sourceValues) return String(row.sourceValues[column] ?? "").trim();
  const field = SOURCE_FIELDS.find(item => item.aliases.test(normalize(column)));
  return field ? String(row[field.property] ?? "").trim() : "";
}

function supplied(value) {
  return Boolean(value && !/^(?:n\/?a|none|null|unknown|not supplied|address not supplied|imported owner \d+|-)$/i.test(value));
}

export function detectSourceFields(columns, rows) {
  return Object.fromEntries(
    SOURCE_FIELDS.map(field => {
      const candidates = columns.filter(column => field.aliases.test(normalize(column)));
      const populated = candidates.find(column => rows.some(row => supplied(sourceValue(row, column))));
      return [field.id, populated || candidates[0] || ""];
    }),
  );
}

// Which columns could hold each field depends only on the column names, so it is worked out once per list. Mapping a
// row then only checks those few columns for a value, instead of testing every field's pattern against every column
// (which, for each row of a list of tens of thousands, took seconds).
const candidateCache = new Map();
function candidatesFor(columns) {
  const key = columns.join("\u0001");
  let found = candidateCache.get(key);
  if (!found) {
    found = SOURCE_FIELDS.map(field => [field.id, columns.filter(column => field.aliases.test(normalize(column)))]);
    if (candidateCache.size > 50) candidateCache.clear();
    candidateCache.set(key, found);
  }
  return found;
}

/** The same choice detectSourceFields makes for a single row: the first candidate column populated in that row. */
function detectForRow(columns, row) {
  return Object.fromEntries(
    candidatesFor(columns).map(([id, candidates]) => [id, candidates.find(column => supplied(sourceValue(row, column))) || candidates[0] || ""]),
  );
}

export function mappedRecord(columns, row, overrides = {}) {
  const mappings = { ...detectForRow(columns, row), ...overrides };
  const result = Object.fromEntries(
    SOURCE_FIELDS.map(field => [field.property, columns.includes(mappings[field.id]) ? sourceValue(row, mappings[field.id]) : ""]),
  );
  if (!result.name) result.name = [result.firstName, result.lastName].filter(Boolean).join(" ");
  if (!result.address) result.address = [result.streetNumber, result.streetName].filter(Boolean).join(" ");
  return result;
}

export function coordinates(latitude, longitude) {
  if (latitude === undefined || longitude === undefined || latitude === null || longitude === null || !String(latitude).trim() || !String(longitude).trim())
    return null;
  const lat = Number(latitude),
    lng = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : null;
}

// Several parts of a page ask for the same list's evidence on every render. The answer depends only on the rows (an
// array that is replaced, never changed in place), the column names and the mapping, so it is kept per rows array.
const evidenceCache = new WeakMap();

export function sourceEvidence(columns, rows, overrides = {}) {
  const key = columns.join("\u0001") + "\u0002" + JSON.stringify(overrides);
  let byKey = evidenceCache.get(rows);
  if (!byKey) evidenceCache.set(rows, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, computeSourceEvidence(columns, rows, overrides));
  return byKey.get(key);
}

function computeSourceEvidence(columns, rows, overrides) {
  const detected = detectSourceFields(columns, rows);
  const mappedFields = SOURCE_FIELDS.map(field => {
    const requested = overrides[field.id] ?? detected[field.id];
    const column = columns.includes(requested) ? requested : "";
    return { ...field, column, count: column ? rows.filter(row => supplied(sourceValue(row, column))).length : 0 };
  });
  const fields = mappedFields.filter(field => EVIDENCE_FIELDS.some(item => item.id === field.id)).map(field => ({ ...field }));
  const name = fields.find(field => field.id === "name");
  if (!name.count) {
    name.count = rows.filter(row => supplied(mappedRecord(columns, row, overrides).name)).length;
    if (name.count)
      name.column = ["firstName", "lastName"]
        .map(id => mappedFields.find(field => field.id === id)?.column)
        .filter(Boolean)
        .join(" + ");
  }
  const address = fields.find(field => field.id === "address");
  if (!address.count) {
    address.count = rows.filter(row => supplied(mappedRecord(columns, row, overrides).address)).length;
    if (address.count)
      address.column = ["streetNumber", "streetName"]
        .map(id => mappedFields.find(field => field.id === id)?.column)
        .filter(Boolean)
        .join(" + ");
  }
  const pointCount = rows.filter(row => {
    const item = mappedRecord(columns, row, overrides);
    return coordinates(item.latitude, item.longitude);
  }).length;
  return {
    fields,
    mappedFields,
    primary:
      fields.find(field => field.count > 0) ||
      (pointCount ? { id: "coordinates", label: "Coordinates", column: "Latitude + longitude", count: pointCount } : null),
  };
}
