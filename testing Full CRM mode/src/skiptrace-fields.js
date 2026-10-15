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
    aliases: /^(?:(?:property|site|situs|mailing|owner) )?(?:street )?(?:address|street)(?: (?:line )?1)?$/,
  },
  { id: "email", label: "Email", property: "email", aliases: /^(?:(?:owner|primary|contact) )?e ?mail(?: address)?$/ },
  { id: "name", label: "Owner name", property: "name", aliases: /^(?:(?:owner|full|contact|seller) )?name$|^owner$/ },
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
  const field = EVIDENCE_FIELDS.find(item => item.aliases.test(normalize(column)));
  return field ? String(row[field.property] ?? "").trim() : "";
}

function supplied(value) {
  return Boolean(value && !/^(?:n\/?a|none|null|unknown|not supplied|address not supplied|imported owner \d+|-)$/i.test(value));
}

export function detectSourceFields(columns, rows) {
  return Object.fromEntries(
    EVIDENCE_FIELDS.map(field => {
      const candidates = columns.filter(column => field.aliases.test(normalize(column)));
      const populated = candidates.find(column => rows.some(row => supplied(sourceValue(row, column))));
      return [field.id, populated || candidates[0] || ""];
    }),
  );
}

export function sourceEvidence(columns, rows, overrides = {}) {
  const detected = detectSourceFields(columns, rows);
  const fields = EVIDENCE_FIELDS.map(field => {
    const requested = overrides[field.id] ?? detected[field.id];
    const column = columns.includes(requested) ? requested : "";
    return { ...field, column, count: column ? rows.filter(row => supplied(sourceValue(row, column))).length : 0 };
  });
  return { fields, primary: fields.find(field => field.count > 0) || null };
}
