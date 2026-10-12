import { formatNumber } from "./marks";

const PLACEHOLDER = /^(n\/?a|null|none|nan|unknown|undefined|-+|\.+|0+)$/i;

// Columns that tell the rows apart from nothing: the same value on every row, mostly blank, or only placeholders.
// The table leaves them out so its few slots go to useful columns; the row's detail still lists every column.
export function dullColumns(names: string[], rows: Record<string, string | number | null>[]) {
  const dull = new Set<string>();
  if (rows.length < 2) return dull;
  for (const name of names) {
    const values = rows.map(row => String(row[name] ?? "").trim()).filter(value => value !== "" && !PLACEHOLDER.test(value));
    if (values.length < rows.length * 0.1 || new Set(values).size <= 1 && values.length === rows.length) dull.add(name);
  }
  return dull.size === names.length ? new Set<string>() : dull;
}

export function formatCell(name: string, value: string | number | null) {
  if (value === null || value === "") return <span className="muted">–</span>;
  if (/price|value|zestimate/i.test(name) && typeof value === "number") return `$${formatNumber(value)}`;
  return typeof value === "number" && !/zip|year/i.test(name) ? formatNumber(value) : value;
}
