import { regionName } from "../lib/format";
import type { ReadySetup } from "../lib/skiptrace-setup";
import { Check, Field } from "./Bits";
import { SkiptraceColumns } from "./SkiptraceColumns";
import { SkiptraceTemplates } from "./SkiptraceTemplates";

const REGIONS = ["US", "CA", "GB", "IE", "AU", "NZ", "EG", "AE", "SA", "DE", "FR", "ES", "IT", "NL", "IN", "PH", "BR", "MX", "ZA", "NG"];

/** Step 1: which column is what. Phone columns, the owner's name and mail, the property, and the default country. */
export function SkiptraceStepRoles({ s }: { s: ReadySetup }) {
  const { setup, base, config, questionableColumns, confirmedIdentifierColumns } = s;
  return (
    <div className="wizard-step" hidden={s.step !== 0}>
      <article className="card step">
        <header>
          <h2>Match your columns</h2>
        </header>
        <p className="muted">
          Assign a role beside each field. You can choose several phone columns; names and locations help check who the numbers belong to.
        </p>
        <SkiptraceTemplates projectId={s.turf.projectId} columns={setup.columns} config={config} onApply={s.applyTemplate} onError={s.setError} />
        {questionableColumns.length > 0 && (
          <div className="notice" role="alert">
            <span>
              Double-check {questionableColumns.join(", ")}: its name looks like an identifier, not a phone field. Choose another role if these are parcel or
              account numbers.
            </span>
            <Check
              checked={questionableColumns.every(column => confirmedIdentifierColumns.includes(column))}
              onChange={on => s.setConfirmedIdentifierColumns(on ? questionableColumns : [])}
            >
              I verified these are phone numbers
            </Check>
          </div>
        )}
        {base.phone_columns.length === 0 && (
          <p className="notice">Assign at least one field to Phone number to continue. The other roles provide context for the checks.</p>
        )}
        <SkiptraceColumns
          columns={setup.columns}
          samples={setup.column_samples}
          config={base}
          onChange={s.mapColumns}
          countryControl={
            <Field
              label="Default phone country"
              value={base.region}
              searchable
              onChange={region => void s.changeRegion(region ?? "US")}
              options={REGIONS.map(code => ({ value: code, label: `${regionName(code)} (${code})` }))}
            />
          }
        />
      </article>
    </div>
  );
}
