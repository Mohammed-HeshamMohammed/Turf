import { useState } from "react";
import { formatNumber } from "../lib/marks";
import { scrollInPane, type ReadySetup } from "../lib/skiptrace-setup";
import { ROW_GROUPS } from "../lib/skiptrace-workflow";
import type { SkiptraceReport } from "../lib/types";
import { SkiptraceDuplicates } from "./SkiptraceDuplicates";
import { SkiptraceReportDetails } from "./SkiptraceReportDetails";
import { SkiptraceReview } from "./SkiptraceReview";

/** Step 4: what the check found, by row, and the rows themselves to review. Drawn anew for each check, so the review
 * of an earlier check does not stay open over a new one. */
export function SkiptraceStepResults({ s, report }: { s: ReadySetup; report: SkiptraceReport }) {
  const { busy, stale, hasPhones } = s;
  const [reviewFilter, setReviewFilter] = useState("all");
  const [reviewRow, setReviewRow] = useState<number | undefined>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const counts = report.row_counts;

  function showRows(filter: string, rowNumber?: number) {
    setReviewFilter(filter);
    setReviewRow(rowNumber);
    setReviewOpen(true);
    window.setTimeout(() => scrollInPane(document.getElementById(`review-${report.scan_job_id}`)), 0);
  }

  return (
    <div className="wizard-step" hidden={s.step !== 3}>
      {s.freshnessError && (
        <p className="notice" role="alert">
          Cannot verify this check: {s.freshnessError}. Saving stays unavailable until freshness is verified.
        </p>
      )}
      {stale && (
        <p className="notice" role="status">
          <span>
            {s.staleSetup ? "You changed the setup after this check." : "The date or project evidence changed after this check."} These results are out of date;
            check again before saving.
          </span>
          <button type="button" className="button" disabled={busy !== null || !hasPhones} onClick={() => void s.check()}>
            {busy === "scan" ? "Checking…" : "Check again"}
          </button>
        </p>
      )}

      <article className="card step">
        <header>
          <h2>What needs attention?</h2>
          <span className="count">Checked {new Date(report.checked_at).toLocaleString()}</span>
        </header>

        {counts.group_look === undefined ? (
          // a check from before the rows were grouped
          <div className="action-summary">
            {[
              ["callable", "Rows with a usable number"],
              ["known_wrong", "Rows containing known wrong numbers"],
              ["dnc", "Rows containing do-not-call numbers"],
              ["needs_review", "Rows needing review"],
              ["no_phone", "Rows with no phone values"],
            ].map(([filter, label]) => (
              <button type="button" className="summary-item" key={filter} onClick={() => showRows(filter)}>
                <strong>{formatNumber(counts[filter] ?? 0)}</strong>
                <span>{label}</span>
                <small>Review rows →</small>
              </button>
            ))}
          </div>
        ) : (
          <>
            <p className="results-headline">
              <strong>
                {formatNumber(counts.callable ?? 0)} of {formatNumber(report.rows)} rows
              </strong>{" "}
              have a number you can call
              {counts.group_look ? (
                <>
                  ; <strong>{formatNumber(counts.group_look)}</strong> of them need a look first.
                </>
              ) : (
                "."
              )}
            </p>
            <div className="verdict-bar" role="img" aria-label={ROW_GROUPS.map(group => `${counts[`group_${group.id}`] ?? 0} ${group.label}`).join(", ")}>
              {ROW_GROUPS.map(group =>
                counts[`group_${group.id}`] ? <i key={group.id} className={`group-${group.id}`} style={{ flexGrow: counts[`group_${group.id}`] }} /> : null,
              )}
            </div>
            <div className="row-groups">
              {ROW_GROUPS.map(group => (
                <button
                  type="button"
                  key={group.id}
                  className={`row-group group-${group.id}`}
                  disabled={!counts[`group_${group.id}`]}
                  onClick={() => showRows(`group_${group.id}`)}
                >
                  <i aria-hidden="true" />
                  <strong>{formatNumber(counts[`group_${group.id}`] ?? 0)}</strong>
                  <span>{group.label}</span>
                  <small>{group.meaning}</small>
                </button>
              ))}
            </div>
            {(counts.known_wrong > 0 || counts.dnc > 0) && (
              <p className="muted">
                {[
                  counts.known_wrong > 0 &&
                    `${formatNumber(counts.known_wrong)} ${counts.known_wrong === 1 ? "row contains" : "rows contain"} a known wrong number`,
                  counts.dnc > 0 &&
                    `${formatNumber(counts.dnc)} ${counts.known_wrong > 0 ? "" : counts.dnc === 1 ? "row contains " : "rows contain "}a do-not-call number`,
                ]
                  .filter(Boolean)
                  .join(" and ")}
                . When another number in the same row is fine, it becomes the best phone; a blocked number never does.
              </p>
            )}
            <div className="row">
              {counts.group_look > 0 && (
                <button type="button" className="button" onClick={() => showRows("group_look")}>
                  Review the {formatNumber(counts.group_look)} to look at
                </button>
              )}
              <button type="button" className={counts.group_look > 0 ? "button ghost" : "button"} disabled={stale} onClick={() => s.setStep(4)}>
                Save the checked copy
              </button>
            </div>
          </>
        )}
        <details className="step skiptrace-optional">
          <summary>How to read this check</summary>
          <p className="muted">
            These are row counts; categories can overlap. A row with a blocked phone can still have another usable number. Usable includes suspicious and
            unverified numbers: it does not prove ownership or connection. Review blocked numbers without deleting the row.
          </p>
          <p className="muted">
            Cross-file evidence: {report.other_datasets_used.join(", ") || "No other saved lists"}. Manual marks: {Object.keys(report.manual_evidence).length}{" "}
            in this project at check time. Sign-performance measurements use mapped call outcomes.
          </p>
        </details>

        <button type="button" className="link" onClick={() => showRows("all")}>
          Review all checked rows
        </button>
      </article>
      <SkiptraceDuplicates
        found={report.duplicates}
        showRows={showRows}
        datasetId={s.dataset.id}
        version={s.turf.version}
        busy={busy !== null || !hasPhones}
        onCheck={() => void s.check()}
        onChanged={s.turf.refresh}
      />
      <h3 className="report-heading">Details of this check</h3>
      {reviewOpen && (
        <SkiptraceReview
          report={report}
          filter={reviewFilter}
          rowNumber={reviewRow}
          datasetId={s.dataset.id}
          onUpdated={s.turf.refresh}
          onFilter={filter => {
            setReviewFilter(filter);
            setReviewRow(undefined);
          }}
        />
      )}
      <SkiptraceReportDetails
        report={report}
        datasetId={s.dataset.id}
        showRows={showRows}
        busy={busy !== null}
        disableApplySigns={busy !== null || stale || s.freshnessPending}
        onApplySigns={s.applyMeasuredSigns}
        onUndoSigns={s.undoSigns}
      />
    </div>
  );
}
