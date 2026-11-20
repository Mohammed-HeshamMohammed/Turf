import { Icon } from "./Icon";
import { DncRegistry } from "./DncRegistry";
import { NanpaBlocks } from "./NanpaBlocks";
import { ownerNames, signReadiness } from "../lib/skiptrace-workflow";
import { regionName } from "../lib/format";
import type { SkiptraceConfig, SkiptraceSuggestion } from "../lib/types";

type Props = {
  base: SkiptraceConfig;
  outcomeColumn: string | null;
  called: string;
  unreviewed: number;
  statusCount: number;
  ignored: number;
  signs: SkiptraceSuggestion["signals"];
  setStep: (step: number) => void;
  onEvidenceChanged: () => void;
};

export function SkiptraceReadiness({ base, outcomeColumn, called, unreviewed, statusCount, ignored, signs, setStep, onEvidenceChanged }: Props) {
  const signsOn = signs.filter(sign => base.signals[sign.code]);
  const signsBlocked = signsOn.filter(sign => !signReadiness(sign.code, base).ready);
  return (
    <section className="ready-check" aria-labelledby="ready-check-title">
      <h3 id="ready-check-title">Ready to check</h3>
      <ul>
        <li className="ok">
          <Icon name="check" size={14} />
          <span>
            {base.phone_columns.length} phone {base.phone_columns.length === 1 ? "column" : "columns"}: {base.phone_columns.join(", ")}
          </span>
        </li>
        {ownerNames(base).length ? (
          <li className="ok">
            <Icon name="check" size={14} />
            <span>Owner names: {ownerNames(base).join(", ")}</span>
          </li>
        ) : (
          <li className="needs">
            <Icon name="flag" size={14} />
            <span>No owner name column: shared numbers and wrong-person results can't be told apart</span>
            <button type="button" className="link" onClick={() => setStep(0)}>
              Map one
            </button>
          </li>
        )}
        {!outcomeColumn ? (
          <li className="ok">
            <Icon name="check" size={14} />
            <span>Checking without call results</span>
            <button type="button" className="link" onClick={() => setStep(1)}>
              Add them
            </button>
          </li>
        ) : unreviewed ? (
          <li className="needs">
            <Icon name="flag" size={14} />
            <span>
              {unreviewed} of {statusCount} call statuses still need you; their suggested meanings are used if you check now
            </span>
            <button type="button" className="link" onClick={() => setStep(1)}>
              Review them
            </button>
          </li>
        ) : (
          <li className="ok">
            <Icon name="check" size={14} />
            <span>
              All {statusCount} call statuses in {outcomeColumn} are settled
            </span>
          </li>
        )}
        {signsBlocked.length ? (
          <li className="needs">
            <Icon name="flag" size={14} />
            <span>
              {signsOn.length} of {signs.length} warning signs on; {signsBlocked.length === 1 ? "one can't" : `${signsBlocked.length} can't`} work until{" "}
              {signsBlocked.length === 1 ? "its" : "their"} columns are mapped
            </span>
          </li>
        ) : (
          <li className="ok">
            <Icon name="check" size={14} />
            <span>
              {signsOn.length} of {signs.length} warning signs on
            </span>
          </li>
        )}
        <DncRegistry onChanged={onEvidenceChanged} />
        <NanpaBlocks onChanged={onEvidenceChanged} />
      </ul>
      <details className="ready-details">
        <summary>See the full setup</summary>
        <dl className="skiptrace-review-summary">
          <div>
            <dt>Phone columns</dt>
            <dd>{base.phone_columns.join(", ")}</dd>
          </div>
          <div>
            <dt>Country</dt>
            <dd>
              {regionName(base.region)} · row override: {base.country_column ?? "None"}
            </dd>
          </div>
          <div>
            <dt>Owners and mailing fields</dt>
            <dd>
              {[base, ...(base.additional_owners ?? [])]
                .map(
                  (owner, index) =>
                    `Owner ${index + 1}: ${[owner.first_name_column, owner.last_name_column, owner.name_column, owner.mailing_address_column, owner.mailing_city_column, owner.mailing_state_column, owner.mailing_zip_column, owner.owner_type_column].filter(Boolean).join(", ") || "Not mapped"}`,
                )
                .join(" · ")}
            </dd>
          </div>
          <div>
            <dt>Phone owner assignments</dt>
            <dd>
              {base.phone_columns
                .map(
                  column =>
                    `${column}: ${base.phone_owner_map?.[column] === -1 || (base.additional_owners?.length && base.phone_owner_map?.[column] === undefined) ? "Owner unknown" : `Owner ${(base.phone_owner_map?.[column] ?? 0) + 1}`}`,
                )
                .join(" · ")}
            </dd>
          </div>
          <div>
            <dt>Property and vacancy fields</dt>
            <dd>
              {[base.address_column, base.city_column, base.zip_column, base.state_column, base.vacancy_column].filter(Boolean).join(", ") || "Not mapped"}
            </dd>
          </div>
          <div>
            <dt>Outcomes</dt>
            <dd>{outcomeColumn ? `${outcomeColumn} describes ${called}; ${unreviewed} need you; ${ignored} intentionally ignored` : "No outcome column"}</dd>
          </div>
          <div>
            <dt>Warning signs</dt>
            <dd>{signsOn.map(sign => sign.label).join(" · ") || "All configurable signs off"}</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
