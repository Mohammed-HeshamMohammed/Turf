import { numberedOwnerColumns, SOURCE_FIELDS, sourceEvidence } from "./skiptrace-fields.js";
import { Field, Select } from "./ui.jsx";

/** How Turf found a field's column, shown under it. */
const HOW = {
  learned: "Remembered from your earlier choice",
  header: "Matched by its header",
  values: "Matched by its values",
  chosen: "Your choice",
};

export function SourceFieldMapping({ columns, rows, mappings, onChange, hideEmpty = false }) {
  const { mappedFields, fields: evidence } = sourceEvidence(columns, rows, mappings);
  const column = id => mappedFields.find(field => field.id === id)?.column;
  // A name or an address can come from two columns: say so instead of "Not mapped", and show those two fields here.
  const parts = { name: ["firstName", "lastName"], address: ["streetNumber", "streetName"] };
  const builtFrom = id => (!column(id) && parts[id].some(column) ? parts[id].map(column).filter(Boolean) : null);
  function help(field) {
    const from = parts[field.id] && builtFrom(field.id);
    if (from) {
      const count = evidence.find(item => item.id === field.id)?.count || 0;
      return `Built from ${from.join(" + ")} · ${count.toLocaleString()} of ${rows.length.toLocaleString()} rows`;
    }
    if (!field.column) return "Not mapped · original column retained";
    return `${field.count.toLocaleString()} of ${rows.length.toLocaleString()} rows supplied · ${HOW[field.how] || "Matched"}`;
  }
  function renderField(field) {
    return (
      <Field key={field.id} label={field.label + " column"} help={help(field)}>
        <Select aria-label={field.label + " column"} value={field.column} onChange={event => onChange({ ...mappings, [field.id]: event.target.value })}>
          <option value="">Not mapped</option>
          {columns.map(column => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  const identity = ["phone", "address", "email", "name", ...(builtFrom("name") ? parts.name : []), ...(builtFrom("address") ? parts.address : [])];
  const used = new Set(mappedFields.map(field => field.column).filter(Boolean));
  // "Owner 2 First Name" and the like become the lead's further owners.
  const furtherOwners = numberedOwnerColumns(columns).filter(item => Number(item.ordinal) > 1 && !used.has(item.column));
  furtherOwners.forEach(item => used.add(item.column));
  const recognised = columns.filter(item => used.has(item)).length;
  return (
    <div className="source-field-mapping">
      <p className="mapping-summary" role="status">
        Turf recognised <strong>{recognised.toLocaleString()}</strong> of {columns.length.toLocaleString()} columns.
      </p>
      <div className="skip-field-grid">{identity.map(id => renderField(mappedFields.find(field => field.id === id)))}</div>
      {furtherOwners.length > 0 && (
        <p className="muted">Further owners: {furtherOwners.map(item => item.column).join(", ")} · each lead keeps every owner they name.</p>
      )}
      <details className="source-mapping-more">
        <summary>All source fields · names, location, mailing & evidence</summary>
        {[...new Set(SOURCE_FIELDS.map(field => field.group))].map(group => {
          const fields = mappedFields.filter(field => field.group === group && !identity.includes(field.id) && !(hideEmpty && !field.count));
          if (!fields.length) return null;
          return (
            <fieldset key={group}>
              <legend>{group}</legend>
              <div className="skip-field-grid">{fields.map(renderField)}</div>
            </fieldset>
          );
        })}
        <p className="muted">
          Property and mailing addresses stay separate. Coordinates need both latitude (−90 to 90) and longitude (−180 to 180). First and last names can form an
          owner name when no full-name column exists.
        </p>
      </details>
      <p className="muted">
        Turf reads each column's header and its values. Correct anything it got wrong and save: it remembers that header for your next lists.{" "}
        {(columns.length - recognised).toLocaleString()} other source columns retained without a mapping. Every source column remains in the preview and
        original data.
      </p>
    </div>
  );
}
