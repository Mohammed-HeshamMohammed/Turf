import { formatNumber } from "../lib/marks";
import type { ReadySetup } from "../lib/skiptrace-setup";
import type { SkiptraceReport } from "../lib/types";
import { ListDownloads } from "./ListDownloads";
import { CheckedPreview } from "./SkiptraceReview";

/** Step 5: saving the checked copy of the list, from the exact check that was reviewed. */
export function SkiptraceStepSave({ s, report }: { s: ReadySetup; report: SkiptraceReport }) {
  const { turf, dataset, base, busy, stale, saved, copy } = s;
  return (
    <div className="wizard-step" hidden={s.step !== 4}>
      <article className="card step">
        <header>
          <h2>Save the checked copy</h2>
          <span className="count">Checked {new Date(report.checked_at).toLocaleString()}</span>
        </header>
        <p className="muted">
          A new list with all {formatNumber(report.rows)} rows and the results added. {dataset.name} itself stays as it is.
        </p>
        {stale && (
          <p className="notice" role="status">
            The setup, date, or evidence changed.{" "}
            <button type="button" className="button" disabled={busy !== null || !s.hasPhones} onClick={() => void s.check()}>
              Check again
            </button>
          </p>
        )}
        {s.freshnessError && (
          <p role="alert" className="notice">
            {s.freshnessError}
          </p>
        )}
        {copy && !saved && (
          <p className="muted">
            A checked copy was saved before:{" "}
            <button type="button" className="link" onClick={() => turf.open("lists", copy.id)}>
              {copy.name}
            </button>{" "}
            ({new Date(copy.created_at).toLocaleString()}). Saving again adds a newer one; the earlier one stays.
          </p>
        )}
        <section className="copy-contents" aria-labelledby={`copy-contents-${dataset.id}`}>
          <h3 id={`copy-contents-${dataset.id}`}>What the copy adds</h3>
          <ul>
            <li>
              <strong>Best phone</strong>: the number to call first in each row, with its verdict, quality, calling restriction and why it was chosen.{" "}
              {formatNumber(report.row_counts.callable ?? report.rows_with_callable_number)} of {formatNumber(report.rows)} rows have one.
            </li>
            <li>
              <strong>For {base.phone_columns.length === 1 ? base.phone_columns[0] : `each of ${base.phone_columns.join(", ")}`}</strong>: its verdict, why, the
              number in international format, and the kind of line.
            </li>
          </ul>
          <details>
            <summary>All {report.added_columns.length} added columns</summary>
            <div className="column-chips">
              {report.added_columns.map(column => (
                <span key={column}>{column}</span>
              ))}
            </div>
          </details>
        </section>
        <label className="field save-copy-name">
          <span>Name of the checked copy</span>
          <input
            className="input"
            value={s.copyName}
            disabled={busy !== null}
            placeholder={`${dataset.name} (phones checked)`}
            onChange={event => s.setCopyName(event.target.value)}
          />
        </label>
        {s.freshnessPending && (
          <p className="muted" role="status">
            Verifying the check before saving…
          </p>
        )}
        <details className="step skiptrace-optional">
          <summary>Preview the checked copy</summary>
          <CheckedPreview report={report} />
        </details>
        {saved && (
          <div className="notice good saved-copy" role="status">
            <span>
              Saved {formatNumber(saved.rows)} rows with {saved.added_columns.length} new columns as a new list.
            </span>
            <div className="row">
              <button type="button" className="button" onClick={() => turf.open("lists", saved.dataset_id)}>
                Open in Lists
              </button>
              <ListDownloads datasetId={saved.dataset_id} checkedId={saved.dataset_id} fail={turf.fail} />
            </div>
          </div>
        )}
      </article>
    </div>
  );
}

/** Under step 5, with or without a check: the original file, and every checked copy saved so far. */
export function SkiptraceCopies({ s }: { s: ReadySetup }) {
  const { turf, dataset, copies } = s;
  return (
    <div className="wizard-step" hidden={s.step !== 4}>
      <details className="card step">
        <summary>Downloads and original file</summary>
        <p className="muted">Your original file stays in this project. Each saved checked copy keeps all rows and result columns for download later.</p>
        <ListDownloads datasetId={dataset.id} fail={turf.fail} />
      </details>
      {copies.length > 0 && (
        <details className="card step">
          <summary>Checked-copy history ({copies.length})</summary>
          <p className="muted">The newest copy is used when you open the original in Lists. Every previous copy remains available.</p>
          <ul className="copy-history">
            {copies.map((item, index) => (
              <li key={item.id}>
                <button type="button" className="link" onClick={() => turf.open("lists", item.id)}>
                  {item.name}
                </button>
                <span>
                  {index === 0 ? "Latest · " : ""}
                  {new Date(item.created_at).toLocaleString()} · {formatNumber(item.row_count)} rows
                </span>
                <ListDownloads datasetId={item.id} checkedId={item.id} fail={turf.fail} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
