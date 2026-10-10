import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OwnerColumns, SkiptraceConfig } from "../lib/types";
import { SearchBox } from "./Bits";
import { Select } from "./Select";

const OWNER_ROLES = [
  { value: "first_name_column", label: "Owner first name" },
  { value: "last_name_column", label: "Owner last name" },
  { value: "name_column", label: "Owner full name" },
  { value: "mailing_address_column", label: "Mailing address" },
  { value: "mailing_city_column", label: "Mailing city" },
  { value: "mailing_state_column", label: "Mailing state" },
  { value: "mailing_zip_column", label: "Mailing ZIP / postal code" },
  { value: "owner_type_column", label: "Owner type" },
] as const;
const PROPERTY_ROLES = [
  { value: "address_column", label: "Property street address" },
  { value: "city_column", label: "Property city" },
  { value: "state_column", label: "Property state" },
  { value: "zip_column", label: "Property ZIP / postal code" },
  { value: "country_column", label: "Country" },
  { value: "business_column", label: "Company" },
  { value: "vacancy_column", label: "Vacancy / vacant" },
] as const;
const ROLES = [{ value: "phone", label: "Phone number" }, ...OWNER_ROLES, ...PROPERTY_ROLES, { value: "unused", label: "Not used in this step" }] as const;
type OwnerRole = typeof OWNER_ROLES[number]["value"];
type Role = typeof ROLES[number]["value"];
type ColumnFilter = "mapped" | "all" | "phone" | "owner" | "property" | "unused";
const ownerRoles = OWNER_ROLES.map(role => role.value);
const propertyRoles = PROPERTY_ROLES.map(role => role.value);
const isOwnerRole = (role: Role): role is OwnerRole => ownerRoles.some(key => key === role);

function assignment(config: SkiptraceConfig, column: string): { role: Role; owner: number } {
  if (config.phone_columns.includes(column)) return { role: "phone", owner: config.phone_owner_map?.[column] ?? ((config.additional_owners?.length ?? 0) ? -1 : 0) };
  for (const [index, owner] of [config, ...(config.additional_owners ?? [])].entries()) {
    const role = ownerRoles.find(key => owner[key] === column);
    if (role) return { role, owner: index };
  }
  return { role: propertyRoles.find(key => config[key] === column) ?? "unused", owner: 0 };
}

export function SkiptraceColumns({ columns, samples, config, onChange, countryControl }: {
  columns: string[]; samples: Record<string, string[]>; config: SkiptraceConfig; onChange: (next: SkiptraceConfig) => void; countryControl?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<ColumnFilter>(() => columns.some(column => assignment(config, column).role !== "unused") ? "mapped" : "all");
  function includes(column: string, scope: ColumnFilter) {
    const role = assignment(config, column).role;
    return scope === "all" || (scope === "mapped" ? role !== "unused" : scope === "owner" ? isOwnerRole(role) : scope === "property" ? propertyRoles.some(key => key === role) : role === scope);
  }
  const matching = columns.filter(column => column.toLowerCase().includes(query.trim().toLowerCase()));
  const visible = matching.filter(column => includes(column, filter));
  const filters: { value: ColumnFilter; label: string }[] = [{ value: "mapped", label: "Mapped" }, { value: "phone", label: "Phones" }, { value: "owner", label: "Owners & mailing" }, { value: "property", label: "Property" }, { value: "unused", label: "Other fields" }, { value: "all", label: "All fields" }];
  const ownerOptions = [config, ...(config.additional_owners ?? [])].map((_, index) => ({ value: String(index), label: `Owner ${index + 1}` }));
  useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [filter, query]);

  function assign(column: string, role: Role, ownerIndex = assignment(config, column).owner) {
    const current = assignment(config, column);
    if (current.role === role && current.owner === ownerIndex) return;
    const next: SkiptraceConfig = { ...config, additional_owners: (config.additional_owners ?? []).map(owner => ({ ...owner })), phone_owner_map: { ...config.phone_owner_map }, phone_columns: config.phone_columns.filter(item => item !== column) };
    for (const owner of [next, ...next.additional_owners!]) for (const key of ownerRoles) if (owner[key] === column) owner[key] = null;
    for (const key of propertyRoles) if (next[key] === column) next[key] = null;
    delete next.phone_owner_map![column];
    if (role === "phone") {
      next.phone_columns.push(column);
      if (current.role !== "phone") ownerIndex = ownerOptions.length > 1 ? -1 : 0;
      if (ownerIndex >= 0) next.phone_owner_map![column] = ownerIndex;
    } else if (isOwnerRole(role)) {
      if (current.role !== role) {
        const available = [next, ...next.additional_owners!].findIndex(owner => !owner[role]);
        if (available >= 0) ownerIndex = available;
      }
      const owner: OwnerColumns = ownerIndex > 0 ? next.additional_owners![ownerIndex - 1] : next;
      owner[role] = column;
    } else if (role !== "unused") next[role] = column;
    onChange(next);
  }

  function addOwner() {
    onChange({ ...config, additional_owners: [...(config.additional_owners ?? []), {}], phone_owner_map: config.additional_owners?.length ? config.phone_owner_map : Object.fromEntries(config.phone_columns.map(column => [column, config.phone_owner_map?.[column] ?? 0])) });
  }
  function removeLastOwner() {
    const index = config.additional_owners!.length;
    onChange({ ...config, additional_owners: config.additional_owners!.slice(0, -1), phone_owner_map: Object.fromEntries(config.phone_columns.map(column => [column, config.phone_owner_map?.[column] === index ? -1 : config.phone_owner_map?.[column] ?? -1])) });
  }

  return <section className="skiptrace-columns" aria-label="Column roles">
    <div className="skiptrace-owner-tools">
      <span>{ownerOptions.length} owner {ownerOptions.length === 1 ? "group" : "groups"}</span>
      <button type="button" className="button ghost small" onClick={addOwner} disabled={ownerOptions.length >= 20}>Add another owner</button>
      {ownerOptions.length > 1 && <button type="button" className="link" onClick={removeLastOwner}>Remove Owner {ownerOptions.length}</button>}
    </div>
    <p className="muted">Map names and mailing fields to an owner group. Assign each phone to its known owner; group order does not indicate current ownership.</p>
    <div className="skiptrace-column-tools">
      <SearchBox value={query} onChange={value => { setQuery(value); if (value.trim()) setFilter("all"); }} placeholder="Find a column" />
      <span className="muted">{config.phone_columns.length} phone {config.phone_columns.length === 1 ? "column" : "columns"} · {columns.length} source fields</span>
      {countryControl && <div className="skiptrace-country">{countryControl}</div>}
    </div>
    <div className="skiptrace-column-filters" role="group" aria-label="Filter column roles">
      {filters.map(scope => <button type="button" key={scope.value} aria-pressed={filter === scope.value} onClick={() => setFilter(scope.value)}>{scope.label} <span>{columns.filter(column => includes(column, scope.value)).length}</span></button>)}
    </div>
    <div className="skiptrace-column-list" role="region" aria-label="Source column mappings" tabIndex={0} ref={list}>
      <div className="skiptrace-column-head" aria-hidden="true"><span>Source field</span><span>Sample values</span><span>Use as</span><span>Owner</span></div>
      {visible.map(column => {
        const { role, owner } = assignment(config, column);
        return <div className="skiptrace-column-row" key={column}>
          <strong className="skiptrace-column-name">{column}</strong>
          <small className="skiptrace-column-samples" title={(samples[column] ?? []).join(" · ")}>{(samples[column] ?? []).join(" · ") || "No nonempty sample"}</small>
          <Select portal searchable label={`Role for ${column}`} value={role} options={[...ROLES]} onChange={next => assign(column, next as Role)} />
          {isOwnerRole(role) || role === "phone" ? <Select portal label={`Owner for ${column}`} value={String(owner)} options={role === "phone" ? [{ value: "-1", label: "Owner not assigned" }, ...ownerOptions] : ownerOptions} onChange={index => assign(column, role, Number(index))} /> : <span className="skiptrace-column-no-owner muted">—</span>}
        </div>;
      })}
      {!visible.length && <p className="skiptrace-column-empty muted">No fields match this view. Choose All fields or change your search.</p>}
    </div>
  </section>;
}
