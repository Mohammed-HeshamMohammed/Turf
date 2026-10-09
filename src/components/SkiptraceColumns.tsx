import { useState } from "react";
import type { SkiptraceConfig } from "../lib/types";
import { SearchBox } from "./Bits";
import { Select } from "./Select";

const ROLES = [
  { value: "phone", label: "Phone number" },
  { value: "first_name_column", label: "First name" },
  { value: "last_name_column", label: "Last name" },
  { value: "name_column", label: "Full name" },
  { value: "address_column", label: "Street address" },
  { value: "state_column", label: "State" },
  { value: "zip_column", label: "ZIP / postal code" },
  { value: "country_column", label: "Country" },
  { value: "business_column", label: "Company" },
  { value: "unused", label: "Not used in this step" },
] as const;
type Role = typeof ROLES[number]["value"];
type ContextRole = Exclude<Role, "phone" | "unused">;
const contextRoles = ROLES.filter(role => role.value !== "phone" && role.value !== "unused").map(role => role.value as ContextRole);

function columnRole(config: SkiptraceConfig, column: string): Role {
  if (config.phone_columns.includes(column)) return "phone";
  return contextRoles.find(role => config[role] === column) ?? "unused";
}

export function SkiptraceColumns({ columns, samples, config, onChange }: {
  columns: string[]; samples: Record<string, string[]>; config: SkiptraceConfig; onChange: (next: SkiptraceConfig) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const matching = columns.filter(column => column.toLowerCase().includes(query.trim().toLowerCase()));
  const visible = matching.filter((column, index) => query.trim() || showAll || index < 8 || columnRole(config, column) !== "unused");

  function assign(column: string, role: Role) {
    if (columnRole(config, column) === role) return;
    const next = { ...config, phone_columns: config.phone_columns.filter(item => item !== column) };
    for (const key of contextRoles) if (next[key] === column) next[key] = null;
    if (role === "phone") next.phone_columns.push(column);
    else if (role !== "unused") next[role] = column;
    onChange(next);
  }

  return <section className="skiptrace-columns" aria-label="Column roles">
    <div className="skiptrace-column-tools">
      <SearchBox value={query} onChange={setQuery} placeholder="Find a column" />
      <span className="muted">{config.phone_columns.length} phone {config.phone_columns.length === 1 ? "column" : "columns"} · {visible.length} of {columns.length} fields shown</span>
    </div>
    <div className="skiptrace-column-list">
      {visible.map(column => <div className="skiptrace-column-row" key={column}>
        <div className="skiptrace-column-source"><strong>{column}</strong><small>{(samples[column] ?? []).join(" · ") || "No nonempty sample"}</small></div>
        <Select label={`Role for ${column}`} value={columnRole(config, column)} options={[...ROLES]} onChange={role => assign(column, role as Role)} />
      </div>)}
    </div>
    {!visible.length && <p className="muted">No column matches that search.</p>}
    {!query.trim() && !showAll && visible.length < columns.length && <button type="button" className="link" onClick={() => setShowAll(true)}>Show all {columns.length} columns</button>}
  </section>;
}
