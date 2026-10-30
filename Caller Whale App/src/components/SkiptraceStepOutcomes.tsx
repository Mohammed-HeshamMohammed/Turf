import { useState } from "react";
import { formatNumber } from "../lib/marks";
import type { ReadySetup } from "../lib/skiptrace-setup";
import { reviewNote, statusPage, toggled } from "../lib/skiptrace-workflow";
import { Check, Field, SearchBox } from "./Bits";
import { DialerEvidence } from "./DialerEvidence";

/** Step 2: the column that holds call results, and what each status in it means. */
export function SkiptraceStepOutcomes({ s }: { s: ReadySetup }) {
  const { setup, base, outcomeColumn, statuses, meaning, reviewed, unreviewed, statusBusy, busy } = s;
  const [query, setQuery] = useState("");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [dialerOpen, setDialerOpen] = useState(false);
  const [mappingMessage, setMappingMessage] = useState<string | null>(null);
  const view = statusPage(statuses, query, unreviewedOnly, reviewed, s.statusPageIndex);
  const columnOptions = setup.columns.map(column => ({ value: column, label: column, description: (setup.column_samples[column] ?? []).join(" · ") }));
  const listed = outcomeColumn && statuses.length > 0;

  return (
    <div className="wizard-step" hidden={s.step !== 1}>
      <article className="card step">
        <header>
          <h2>Use call results, if you have them</h2>
        </header>
        <p className="muted">Map existing call results, or continue without call history.</p>
        <button
          type="button"
          className="link skiptrace-skip"
          disabled={!s.hasPhones || statusBusy || busy !== null || s.importingLegacy}
          onClick={async () => {
            await s.chooseOutcomeColumn(null);
            s.setStep(2);
          }}
        >
          Continue without call outcomes
        </button>
        <details className="step skiptrace-optional" onToggle={event => setDialerOpen(event.currentTarget.open)}>
          <summary>Import or map a dialer export</summary>
          {dialerOpen && <DialerEvidence callerwhale={s.callerwhale} datasetId={s.dataset.id} />}
        </details>
        <div className="fields">
          <Field
            label="Status column"
            value={outcomeColumn}
            searchable
            optional="No outcome column"
            options={s.outcomeColumns.map(column => ({ value: column, label: column }))}
            onChange={column => void s.chooseOutcomeColumn(column)}
          />
          {outcomeColumn && base.phone_columns.length > 0 && (
            <Field
              label="The status describes the call to"
              value={s.called}
              options={base.phone_columns.map(column => ({ value: column, label: column }))}
              onChange={column => s.setCalled(column ?? "")}
            />
          )}
          <Field
            label="Call date column (optional)"
            value={base.call_date_column ?? null}
            searchable
            optional="Date unknown"
            options={columnOptions}
            onChange={call_date_column => s.patch({ call_date_column })}
          />
        </div>
        {statusBusy && <p role="status">Loading status meanings…</p>}
        {outcomeColumn && (
          <details className="step skiptrace-optional">
            <summary>How call meanings and dates are used</summary>
            <p className="muted">
              Known wrong numbers and disconnected lines apply across the project. Wrong person applies to the assigned owner of the called phone field and
              needs a mapped name. Reached means someone answered; it cannot also be a negative outcome. DNC can accompany either. Voicemail and no answer
              record activity only.
            </p>
            <p className="muted">
              Dates inside statuses use {base.region === "US" ? "month/day/year" : "day/month/year"}; year-first dates stay unambiguous. DNC end dates are
              inclusive. Undated successful calls have an unknown age.
            </p>
          </details>
        )}
        {listed && (
          <>
            <p className="status-summary">
              <strong>
                {unreviewed.length ? `${unreviewed.length} ${unreviewed.length === 1 ? "status needs" : "statuses need"} you` : "Every status is settled"}
              </strong>
              <span className="muted">
                {" "}
                · {s.automatic} settled automatically · {s.settledBefore} decided before · {s.ignored.length} ignored
              </span>
            </p>
            <p className="muted">
              {unreviewed.length
                ? "The ones that need you are at the top, each with the reason. Confirm or ignore one and it moves to the bottom; "
                : "Look over the automatic ones below if you like; "}
              what you choose is remembered for every list in this project. If you change a meaning, press Confirm to finish that status.
              {s.modelState === "ready" ? " Unfamiliar wording is also compared with a small model on this computer." : ""}
            </p>
            {s.modelState === "downloading" && (
              <p className="muted" role="status">
                Getting the small status model ready (first time only, about 31 MB). Statuses are read without it until then and update by themselves.
              </p>
            )}
            <div className="row">
              <SearchBox
                value={query}
                onChange={value => {
                  setQuery(value);
                  s.setStatusPageIndex(0);
                }}
                placeholder="Search call statuses"
              />
              <Check
                checked={unreviewedOnly}
                onChange={on => {
                  setUnreviewedOnly(on);
                  s.setStatusPageIndex(0);
                }}
              >
                Only what needs me
              </Check>
              {unreviewed.length > 0 && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => {
                    s.setReviewed(statuses.map(item => item.key));
                    s.decide(Object.fromEntries(unreviewed.map(item => [item.key, meaning[item.key] ?? []])));
                  }}
                >
                  Looks right: confirm all {unreviewed.length}
                </button>
              )}
            </div>
            <div className="table-wrap status-mapping-table">
              <table className="compact">
                <caption className="sr-only">What each status means</caption>
                <thead>
                  <tr>
                    <th scope="col">Status / rows</th>
                    <th scope="col">Meaning</th>
                    <th scope="col">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {view.rows.map(status => {
                    const note = reviewNote(status, reviewed.includes(status.key), meaning[status.key]);
                    return (
                      <tr key={status.key} className={note.needs ? "needs-you" : undefined}>
                        <th scope="row">
                          {status.example}
                          <small className="status-row-count muted">{formatNumber(status.count)} rows</small>
                        </th>
                        <td>
                          <details className="status-meanings">
                            <summary aria-label={`Edit meanings for ${status.example}`}>
                              {setup.outcomes
                                .filter(outcome => (meaning[status.key] ?? []).includes(outcome.id))
                                .map(outcome => outcome.label)
                                .join(" · ") || "No outcome"}
                              <span className="muted">Edit</span>
                            </summary>
                            <div className="status-meaning-options">
                              {setup.outcomes.map(outcome => (
                                <Check
                                  label={`${status.example}: ${outcome.label}`}
                                  checked={(meaning[status.key] ?? []).includes(outcome.id)}
                                  key={outcome.id}
                                  onChange={on => {
                                    s.setMeaning({ ...meaning, [status.key]: toggled(meaning[status.key] ?? [], outcome.id, on) });
                                  }}
                                >
                                  {outcome.label}
                                </Check>
                              ))}
                            </div>
                          </details>
                        </td>
                        <td>
                          <span className={note.needs ? "status-note needs" : "status-note muted"}>{note.label}</span>
                          {note.detail && <small className="status-why muted">{note.detail}</small>}
                          <div className="row">
                            <button type="button" className="link" onClick={() => s.confirmStatus(status.key, meaning[status.key] ?? [])}>
                              Confirm
                            </button>
                            <button
                              type="button"
                              className="link"
                              onClick={() => {
                                s.setMeaning({ ...meaning, [status.key]: [] });
                                s.confirmStatus(status.key, []);
                              }}
                            >
                              Ignore
                            </button>
                            {reviewed.includes(status.key) && (
                              <button
                                type="button"
                                className="link"
                                onClick={() => {
                                  s.setReviewed(reviewed.filter(key => key !== status.key));
                                  s.decide({ [status.key]: null });
                                }}
                              >
                                Mark unreviewed
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <footer className="pager">
              <span>{view.total} matching statuses</span>
              <div className="row">
                <button type="button" className="button ghost small" disabled={view.current === 0} onClick={() => s.setStatusPageIndex(view.current - 1)}>
                  Previous
                </button>
                <span>
                  Page {view.current + 1} of {view.pages}
                </span>
                <button
                  type="button"
                  className="button ghost small"
                  disabled={view.current + 1 >= view.pages}
                  onClick={() => s.setStatusPageIndex(view.current + 1)}
                >
                  Next
                </button>
              </div>
            </footer>
          </>
        )}
        {outcomeColumn && !statusBusy && statuses.length === 0 && (
          <p className="muted">This status column has no nonempty values. You can continue without call outcomes.</p>
        )}
        {outcomeColumn && (
          <div className="row">
            <button
              type="button"
              className="button ghost"
              disabled={busy !== null || statusBusy || s.missing.length > 0 || !s.hasPhones}
              onClick={async () => {
                setMappingMessage(null);
                if (await s.saveMappings()) setMappingMessage("Dialer mappings saved. Return to your lead list and check phones to use these results.");
              }}
            >
              Save outcome mappings
            </button>
            {mappingMessage && <span role="status">{mappingMessage}</span>}
          </div>
        )}
      </article>
    </div>
  );
}
