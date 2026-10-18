import { SOURCE_FIELDS, sourceEvidence } from "./skiptrace-fields.js";
import { Field } from "./ui.jsx";

export function SourceFieldMapping({ columns, rows, mappings, onChange, hideEmpty = false }) {
  const { mappedFields } = sourceEvidence(columns, rows, mappings);
  function renderField(field) {
    return (
      <Field
        key={field.id}
        label={field.label + " column"}
        help={field.column ? `${field.count} of ${rows.length} rows supplied` : "Not mapped · original column retained"}
      >
        <select aria-label={field.label + " column"} value={field.column} onChange={event => onChange({ ...mappings, [field.id]: event.target.value })}>
          <option value="">Not mapped</option>
          {columns.map(column => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  const identity = ["phone", "address", "email", "name"];
  const used = new Set(mappedFields.map(field => field.column).filter(Boolean));
  return (
    <div className="source-field-mapping">
      <div className="skip-field-grid">{mappedFields.filter(field => identity.includes(field.id)).map(renderField)}</div>
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
        {columns.filter(column => !used.has(column)).length} other source columns retained without a mapping. Every source column remains in the preview and
        original data.
      </p>
    </div>
  );
}
