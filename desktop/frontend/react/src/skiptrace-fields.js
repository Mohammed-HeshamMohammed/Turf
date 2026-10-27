import { FIRST_WORDS, LAST_WORDS, MAILING_WORDS, OWNER_WORDS, VOCABULARY } from "./field-vocabulary.js";

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
  { id: "name", label: "Owner name", property: "name", aliases: /^(?:(?:owner(?: 1)?|full|contact|seller) )?(?:full )?name$|^owner(?: 1)?$/ },
];

export const SOURCE_FIELDS = [
  ...EVIDENCE_FIELDS.map(field => ({ ...field, group: "Contact & identity" })),
  { id: "firstName", label: "First name", property: "firstName", group: "Contact & identity", aliases: /^(?:owner(?: 1)? |contact )?first name$/ },
  { id: "lastName", label: "Last name", property: "lastName", group: "Contact & identity", aliases: /^(?:owner(?: 1)? |contact )?(?:last name|surname)$/ },
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
  {
    id: "value",
    label: "Property value",
    property: "value",
    group: "Mailing & evidence",
    aliases: /^(?:(?:property|estimated|est|market|assessed|total assessed) )?(?:value|price)$/,
  },
  // The building and lot, as county-record exports (PropStream, BatchLeads, ListSource) name them.
  { id: "beds", label: "Bedrooms", property: "beds", group: "Property details", aliases: /^(?:bedrooms?|beds?|br)$/ },
  { id: "baths", label: "Bathrooms", property: "baths", group: "Property details", aliases: /^(?:bathrooms?|baths?|ba)$/ },
  {
    id: "area",
    label: "Living area (sq ft)",
    property: "area",
    group: "Property details",
    aliases: /^(?:living (?:square feet|sq ft|sqft|area)|building (?:square feet|sq ft|sqft|area)|square (?:feet|footage)|sq ft|sqft)$/,
  },
  { id: "yearBuilt", label: "Year built", property: "yearBuilt", group: "Property details", aliases: /^(?:year built|built|yr built)$/ },
  { id: "lotAcres", label: "Lot (acres)", property: "lotAcres", group: "Property details", aliases: /^(?:lot (?:acres|size acres)|acreage|acres)$/ },
  { id: "lotSqft", label: "Lot (sq ft)", property: "lotSqft", group: "Property details", aliases: /^lot (?:square feet|sq ft|sqft|size)$/ },
  { id: "propertyType", label: "Property type", property: "propertyType", group: "Property details", aliases: /^property type$/ },
  { id: "propertyUse", label: "Property use", property: "propertyUse", group: "Property details", aliases: /^property use$/ },
  { id: "landUse", label: "Land use", property: "landUse", group: "Property details", aliases: /^land use$/ },
  { id: "units", label: "Units", property: "units", group: "Property details", aliases: /^(?:units?(?: count)?|number of units|of units)$/ },
  { id: "stories", label: "Stories", property: "stories", group: "Property details", aliases: /^(?:of )?(?:stories|floors)$/ },
  { id: "garageType", label: "Garage type", property: "garageType", group: "Property details", aliases: /^garage(?: type)?$/ },
  { id: "garageSqft", label: "Garage (sq ft)", property: "garageSqft", group: "Property details", aliases: /^garage (?:square feet|sq ft|sqft|area)$/ },
  { id: "carport", label: "Carport", property: "carport", group: "Property details", aliases: /^carport(?: type)?$/ },
  { id: "carportSqft", label: "Carport (sq ft)", property: "carportSqft", group: "Property details", aliases: /^carport (?:area|square feet|sq ft|sqft)$/ },
  {
    id: "cooling",
    label: "Air conditioning",
    property: "cooling",
    group: "Property details",
    aliases: /^(?:air conditioning(?: type)?|cooling(?: type)?|ac)$/,
  },
  { id: "heating", label: "Heating", property: "heating", group: "Property details", aliases: /^heating(?: type)?$/ },
  { id: "fireplaces", label: "Fireplaces", property: "fireplaces", group: "Property details", aliases: /^(?:of )?fireplaces$/ },
  { id: "subdivision", label: "Subdivision", property: "subdivision", group: "Property details", aliases: /^subdivision(?: name)?$/ },
  { id: "legal", label: "Legal description", property: "legal", group: "Property details", aliases: /^legal description$/ },
  // The owner and their hold on the property.
  { id: "ownerType", label: "Owner type", property: "ownerType", group: "Ownership", aliases: /^owner type$/ },
  { id: "ownerOccupied", label: "Owner occupied", property: "ownerOccupied", group: "Ownership", aliases: /^owner occupied$/ },
  { id: "vacant", label: "Vacant", property: "vacant", group: "Ownership", aliases: /^(?:vacant|vacancy)$/ },
  {
    id: "ownershipMonths",
    label: "Ownership length (months)",
    property: "ownershipMonths",
    group: "Ownership",
    aliases: /^(?:ownership length(?: months)?|months owned|length of ownership(?: months)?)$/,
  },
  { id: "sourceId", label: "Record ID in the source", property: "sourceId", group: "Ownership", aliases: /^(?:id|record id|property id|lead id)$/ },
];

const normalize = column =>
  String(column)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([\p{L}])(\d)/gu, "$1 $2")
    .replace(/(\d)([\p{L}])/gu, "$1 $2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** A header's words. */
const words = text => normalize(text).split(" ").filter(Boolean);

export function sourceValue(row, column) {
  if (row.sourceValues) return String(row.sourceValues[column] ?? "").trim();
  const field = SOURCE_FIELDS.find(item => item.aliases.test(normalize(column)));
  return field ? String(row[field.property] ?? "").trim() : "";
}

function supplied(value) {
  return Boolean(value && !/^(?:n\/?a|none|null|unknown|not supplied|address not supplied|imported owner \d+|-)$/i.test(value));
}

// ---- Smart mapping -----------------------------------------------------------------------------------------------
//
// Lists name their columns in every way: "Owner Name", "Customer", "Client Full Name", "Seller", a first and last name
// in two columns, or a header that says nothing ("Column 7"). Each column is scored for each field from three things:
//   1. what you taught Turf: a header you mapped by hand before maps the same way again (learned);
//   2. the header's words against the field's vocabulary (field-vocabulary.js);
//   3. the values: phone numbers, email addresses, ZIP codes, street addresses, people's names, years and prices
//      look like what they are, which confirms a header, overrules a misleading one, or names an unlabelled column.
// Then every column goes to the field it fits best, highest scores first, one field per column.

const VOCAB = Object.fromEntries(Object.entries(VOCABULARY).map(([id, phrases]) => [id, phrases.map(words)]));
const has = (tokens, list) => tokens.some(token => list.some(word => token === word || token.startsWith(word)));
const LOCATION_FIELDS = new Set(["address", "unit", "streetNumber", "streetName", "city", "region", "zip", "country"]);
const NAME_FIELDS = new Set(["name", "firstName", "lastName"]);

let learned = {};
let learnedVersion = 0;
/** The headers people mapped by hand ({normalised header: field id}); kept in the workspace settings. */
export function setLearnedHeaders(map) {
  const next = map && typeof map === "object" ? map : {};
  if (JSON.stringify(next) === JSON.stringify(learned)) return;
  learned = next;
  learnedVersion++;
}
export const headerKey = column => normalize(column);

/** How well a header's words name a field, 0 to 1. */
function headerScore(field, column) {
  const tokens = words(column);
  if (!tokens.length) return 0;
  const plain = normalize(column);
  let score = field.aliases.test(plain) ? 0.95 : 0;
  for (const phrase of VOCAB[field.id] || []) {
    if (!phrase.length) continue;
    const joined = phrase.join(" ");
    if (joined === tokens.join(" ")) {
      score = Math.max(score, 0.95);
      continue;
    }
    const matched = phrase.filter(word => tokens.includes(word)).length;
    if (matched === phrase.length) score = Math.max(score, 0.7 + 0.25 * (phrase.length / tokens.length));
    else if (phrase.length > 1 && matched / phrase.length >= 0.5) score = Math.max(score, 0.4 * (matched / phrase.length));
  }
  // Words that change what the column is about.
  const mailing = has(tokens, MAILING_WORDS);
  if (mailing && LOCATION_FIELDS.has(field.id)) score *= 0.2;
  if (!mailing && field.id.startsWith("mailing")) score *= 0.3;
  const first = has(tokens, FIRST_WORDS),
    last = has(tokens, LAST_WORDS);
  if (field.id === "name" && (first || last)) score *= 0.3;
  if (field.id === "firstName" && last && !first) score *= 0.2;
  if (field.id === "lastName" && first && !last) score *= 0.2;
  // "Owner 2 …" is a further owner, never the main one.
  const ordinal = tokens.find(token => /^\d+$/.test(token));
  if (NAME_FIELDS.has(field.id) && ordinal && Number(ordinal) > 1 && has(tokens, OWNER_WORDS)) score *= 0.2;
  return Math.min(1, score);
}

const US_STATES = new Set(
  "al ak az ar ca co ct de fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy dc pr".split(
    " ",
  ),
);
const toNumber = value => Number(String(value).replace(/[$,\s]/g, ""));
const isNumber = value => /^-?[$]?\s?[\d,]*\.?\d+$/.test(String(value).trim());
const PERSON = /^[\p{L}][\p{L}'.-]*(?:\s+[\p{L}][\p{L}'.-]*){1,4}$/u;
const WORD = /^[\p{L}][\p{L}'.-]*$/u;

/** What each field's values look like. Fields without a check are decided by their header alone. */
const LOOKS_LIKE = {
  phone: value => {
    const digits = value.replace(/\D/g, "");
    return /^[+\d\s().\-/x]+$/i.test(value) && digits.length >= 7 && digits.length <= 15;
  },
  email: value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
  zip: value => /^\d{5}(?:-\d{4})?$/.test(value) || /^[a-z]\d[a-z] ?\d[a-z]\d$/i.test(value) || /^[a-z]{1,2}\d[a-z\d]? ?\d[a-z]{2}$/i.test(value),
  region: value => US_STATES.has(value.toLowerCase()) || /^[\p{L}][\p{L} .'-]{1,30}$/u.test(value),
  address: value => /^\d+[a-z]?\s+\S+/i.test(value) || /(?:street|avenue|road|blvd|lane|drive|\bst\b|\bave\b|\brd\b|\bdr\b|\bln\b)/i.test(value),
  name: value => PERSON.test(value) && !/\d/.test(value),
  firstName: value => WORD.test(value),
  lastName: value => WORD.test(value) || PERSON.test(value),
  city: value => /^[\p{L}][\p{L} .'-]*$/u.test(value),
  yearBuilt: value => isNumber(value) && Number.isInteger(toNumber(value)) && toNumber(value) >= 1700 && toNumber(value) <= 2035,
  value: value => isNumber(value) && toNumber(value) >= 1000,
  beds: value => isNumber(value) && toNumber(value) >= 0 && toNumber(value) <= 50,
  baths: value => isNumber(value) && toNumber(value) >= 0 && toNumber(value) <= 50,
  units: value => isNumber(value) && toNumber(value) >= 0 && toNumber(value) <= 5000,
  stories: value => isNumber(value) && toNumber(value) >= 0 && toNumber(value) <= 200,
  area: value => isNumber(value) && toNumber(value) > 0,
  lotSqft: value => isNumber(value) && toNumber(value) >= 0,
  lotAcres: value => isNumber(value) && toNumber(value) >= 0,
  latitude: value => isNumber(value) && Math.abs(toNumber(value)) <= 90 && /\./.test(value),
  longitude: value => isNumber(value) && Math.abs(toNumber(value)) <= 180 && /\./.test(value),
  ownershipMonths: value => isNumber(value) && toNumber(value) >= 0,
};
// The few kinds of value clear enough to name a column whose header says nothing. A price needs its dollar sign:
// a bare number could be anything.
const SELF_EVIDENT = {
  email: LOOKS_LIKE.email,
  phone: LOOKS_LIKE.phone,
  address: LOOKS_LIKE.address,
  zip: LOOKS_LIKE.zip,
  name: LOOKS_LIKE.name,
  value: value => /^\$\s?[\d,]+(?:\.\d+)?$/.test(value.trim()) && toNumber(value) >= 1000,
};

/** The share of a column's filled values (from up to 200 rows) that pass a check, and how many are filled. */
function valueShare(fieldId, column, rows, check = LOOKS_LIKE[fieldId]) {
  const sample = [];
  const step = Math.max(1, Math.floor(rows.length / 200));
  for (let index = 0; index < rows.length && sample.length < 200; index += step) {
    const value = sourceValue(rows[index], column);
    if (supplied(value)) sample.push(value);
  }
  if (!sample.length) return { share: null, filled: 0, varied: 0 };
  const varied = new Set(sample.map(value => value.toLowerCase())).size / sample.length;
  return { share: check ? sample.filter(check).length / sample.length : null, filled: sample.length, varied };
}

// How different the values of a field are from row to row, at the least, before values alone may name a column:
// "Not interested" looks like a name, but a column of a few repeated phrases is a status, not people.
const VARIED = { name: 0.6, address: 0.6, email: 0.6, phone: 0.3, zip: 0, value: 0.3 };

const mappingCache = new WeakMap();

/**
 * The best column for every field, and how each was found: { mappings: {field: column}, how: {field: "learned" |
 * "header" | "values"}, scores: {field: 0..1} }. Rows are optional; without them only headers and learning count.
 */
export function smartMapping(columns, rows = []) {
  const key = columns.join("\u0001") + "\u0002" + learnedVersion;
  let byKey = mappingCache.get(rows);
  if (!byKey) mappingCache.set(rows, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key);
  const options = [];
  // A header that clearly names some field is never re-labelled by its values, unless those values contradict it (a
  // "Phone" column full of email addresses): "Original Status" stays a status even though "Not interested" looks like
  // a name.
  const named = new Set(
    columns.filter(column =>
      SOURCE_FIELDS.some(field => {
        if (headerScore(field, column) < 0.5) return false;
        const { share } = rows.length ? valueShare(field.id, column, rows) : { share: null };
        return share === null || share >= 0.2;
      }),
    ),
  );
  for (const column of columns) {
    const taught = learned[normalize(column)];
    for (const field of SOURCE_FIELDS) {
      if (taught) {
        if (taught === field.id) options.push({ field: field.id, column, score: 1.2, how: "learned" });
        continue;
      }
      const header = headerScore(field, column);
      const { share, filled } = rows.length ? valueShare(field.id, column, rows) : { share: null, filled: 0 };
      let score = header,
        how = "header";
      if (share !== null && header >= 0.4) {
        // Values confirm a header, or show it is something else (a "Phone" column full of emails).
        score = header * (0.65 + 0.35 * share);
        if (share < 0.2) score *= 0.4;
      } else if (header < 0.4 && SELF_EVIDENT[field.id] && rows.length && !named.has(column)) {
        const { share: evident, varied } = valueShare(field.id, column, rows, SELF_EVIDENT[field.id]);
        if (evident >= 0.85 && varied >= VARIED[field.id]) {
          score = 0.5 + 0.15 * evident;
          how = "values";
        }
      }
      // Of two equally good columns, the one with values wins.
      if (filled) score += 0.03;
      if (score >= 0.5) options.push({ field: field.id, column, score, how });
    }
  }
  options.sort((a, b) => b.score - a.score);
  const mappings = {},
    how = {},
    scores = {},
    used = new Set();
  // With a first and a last name column, the full name is built from them: no other column is guessed as the name.
  const parts = new Set(
    options.filter(option => option.how !== "values" && (option.field === "firstName" || option.field === "lastName")).map(option => option.field),
  );
  for (const option of options) {
    if (option.field === "name" && option.how === "values" && parts.size === 2) continue;
    if (mappings[option.field] || used.has(option.column)) continue;
    mappings[option.field] = option.column;
    how[option.field] = option.how;
    scores[option.field] = Math.min(1, option.score);
    used.add(option.column);
  }
  const result = { mappings, how, scores };
  byKey.set(key, result);
  return result;
}

/** Every column that holds phone numbers, best first: the Skip Tracing engine checks them all. */
export function phoneColumns(columns, rows) {
  return columns
    .map(column => {
      const taught = learned[normalize(column)];
      const header = taught ? (taught === "phone" ? 1 : 0) : headerScore(SOURCE_FIELDS[0], column);
      const { share } = valueShare("phone", column, rows);
      const score = share === null ? 0 : header >= 0.4 ? header * (0.65 + 0.35 * share) : share >= 0.85 ? 0.5 + 0.15 * share : 0;
      return { column, score };
    })
    .filter(item => item.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .map(item => item.column);
}

export function detectSourceFields(columns, rows) {
  const { mappings } = smartMapping(columns, rows);
  return Object.fromEntries(SOURCE_FIELDS.map(field => [field.id, mappings[field.id] || ""]));
}

// Mapping a row without a saved mapping (a lead page, the map) uses the headers alone, worked out once per list.
const candidateCache = new Map();
function candidatesFor(columns) {
  const key = columns.join("\u0001") + "\u0002" + learnedVersion;
  let found = candidateCache.get(key);
  if (!found) {
    const { mappings } = smartMapping(columns);
    found = SOURCE_FIELDS.map(field => [field.id, mappings[field.id] ? [mappings[field.id]] : []]);
    if (candidateCache.size > 50) candidateCache.clear();
    candidateCache.set(key, found);
  }
  return found;
}

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

/**
 * Every owner a list names, in order: "Owner 1 First Name", "Owner 2 Last Name" and so on, or the single mapped owner.
 * Owners with neither name are left out, so a list's empty Owner 2 does not become a blank person.
 */
const ownerColumnCache = new Map();
/** The numbered owner columns of a list: [{ column, ordinal, part: "first" | "last" | "full" }]. */
export function numberedOwnerColumns(columns) {
  const key = columns.join("\u0001");
  if (!ownerColumnCache.has(key)) {
    const found = [];
    for (const column of columns) {
      const tokens = words(column);
      const ordinal = tokens.find(token => /^\d+$/.test(token));
      if (!ordinal || !has(tokens, OWNER_WORDS) || has(tokens, MAILING_WORDS) || tokens.some(token => /phone|mail/.test(token))) continue;
      found.push({ column, ordinal, part: has(tokens, FIRST_WORDS) ? "first" : has(tokens, LAST_WORDS) ? "last" : "full" });
    }
    if (ownerColumnCache.size > 50) ownerColumnCache.clear();
    ownerColumnCache.set(key, found);
  }
  return ownerColumnCache.get(key);
}

export function ownersOf(columns, row, record) {
  const numbered = new Map();
  for (const { column, ordinal, part } of numberedOwnerColumns(columns)) {
    const owner = numbered.get(ordinal) || {};
    owner[part] = sourceValue(row, column);
    numbered.set(ordinal, owner);
  }
  const names = [...numbered.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, owner]) => (supplied(owner.full) ? owner.full : [owner.first, owner.last].filter(supplied).join(" ")))
    .filter(Boolean);
  if (!names.length && supplied(record?.name)) names.push(record.name);
  return names;
}

const number = value => {
  const parsed = Number(String(value ?? "").replace(/[$,\s]/g, ""));
  return String(value ?? "").trim() !== "" && Number.isFinite(parsed) ? parsed : null;
};

/**
 * What a lead record takes from a source row: the mapped fields, numbers as numbers, every owner, and the mailing
 * address in one line. Values the source does not have stay empty (null), never a made-up default.
 */
export function leadFromSource(columns, row, mappings = {}) {
  const data = mappedRecord(columns, row, mappings);
  const owners = ownersOf(columns, row, data);
  const mailing = [data.mailingAddress, data.mailingCity, [data.mailingRegion, data.mailingZip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    ...data,
    name: data.name || owners[0] || "",
    owners,
    mailing,
    beds: number(data.beds),
    baths: number(data.baths),
    area: number(data.area),
    yearBuilt: number(data.yearBuilt),
    lotAcres: number(data.lotAcres),
    lotSqft: number(data.lotSqft),
    units: number(data.units),
    stories: number(data.stories),
    garageSqft: number(data.garageSqft),
    carportSqft: number(data.carportSqft),
    fireplaces: number(data.fireplaces),
    ownershipMonths: number(data.ownershipMonths),
    value: number(data.value),
  };
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
  const key = columns.join("\u0001") + "\u0002" + JSON.stringify(overrides) + "\u0002" + learnedVersion;
  let byKey = evidenceCache.get(rows);
  if (!byKey) evidenceCache.set(rows, (byKey = new Map()));
  if (!byKey.has(key)) byKey.set(key, computeSourceEvidence(columns, rows, overrides));
  return byKey.get(key);
}

function computeSourceEvidence(columns, rows, overrides) {
  const smart = smartMapping(columns, rows);
  const detected = detectSourceFields(columns, rows);
  const mappedFields = SOURCE_FIELDS.map(field => {
    const chosen = Object.hasOwn(overrides, field.id) && overrides[field.id] !== detected[field.id];
    const requested = overrides[field.id] ?? detected[field.id];
    const column = columns.includes(requested) ? requested : "";
    const how = !column ? "" : chosen ? "chosen" : smart.how[field.id] || "header";
    return { ...field, column, how, count: column ? rows.filter(row => supplied(sourceValue(row, column))).length : 0 };
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
