import { useEffect, useState } from "react";
import { Field, VerdictPill } from "./Bits";
import { overrule, skiptraceReview } from "../lib/service";
import { ROW_GROUPS } from "../lib/skiptrace-workflow";
import { formatNumber, checkedPhoneColumns } from "../lib/marks";
import type { ReviewRow, SkiptraceReport, Verdict } from "../lib/types";
import { PhoneChoices } from "./PhoneChoices";

export function SkiptraceReview({
  report,
  filter,
  rowNumber,
  onFilter,
  datasetId,
  onUpdated,
}: {
  report: SkiptraceReport;
  filter: string;
  rowNumber: number | undefined;
  onFilter: (filter: string) => void;
  datasetId: string;
  onUpdated: () => Promise<void>;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; rows: ReviewRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  // What the person just said about a row and the row it was matched with. The next check follows it.
  const [said, setSaid] = useState<Record<number, string>>({});
  const decide = (rowNumber: number, other: number, same: boolean) =>
    void overrule(datasetId, rowNumber, other, same).then(
      async () => {
        setSaid(current => ({
          ...current,
          [rowNumber]: `Noted: ${same ? "the same lead as" : "not the same lead as"} row ${other}. Check again to apply it.`,
        }));
        await onUpdated();
      },
      reason => setError(reason instanceof Error ? reason.message : String(reason)),
    );
  useEffect(() => {
    setPage(0);
    setExpanded(null);
  }, [filter, rowNumber, report.scan_job_id]);
  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    skiptraceReview(report.scan_job_id, filter, page * 25, rowNumber).then(
      result => current && setData(result),
      reason => current && setError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [report.scan_job_id, filter, rowNumber, page]);
  return (
    <article className="card step" id={`review-${report.scan_job_id}`}>
      <header>
        <h2>Review checked rows</h2>
        <span className="count">Original rows stay intact</span>
      </header>
      <Field
        label="Rows to review"
        value={filter}
        onChange={value => onFilter(value ?? "all")}
        options={[
          { value: "all", label: "All rows" },
          ...ROW_GROUPS.map(group => ({ value: `group_${group.id}`, label: `${group.label}: ${group.meaning}` })),
          { value: "callable", label: "Has a usable number" },
          { value: "known_wrong", label: "Contains a known wrong number" },
          { value: "dnc", label: "Contains a do-not-call number" },
          { value: "needs_review", label: "Something to look at: suspicious numbers, conflicting call results, or old evidence" },
          { value: "no_phone", label: "No phone values" },
          { value: "duplicates", label: "Repeated leads: the row to keep, then the rows that repeat it" },
          { value: "possible_duplicates", label: "Rows that might repeat another" },
          { value: "same_owner", label: "Owners with several properties" },
          ...(["wrong", "suspicious", "unverified", "corroborated"] as const).map(value => ({ value, label: `Best row verdict: ${value}` })),
        ]}
      />
      {rowNumber !== undefined && (
        <p className="muted">
          Showing source row {rowNumber}.{" "}
          <button className="link" onClick={() => onFilter("all")}>
            Show all rows
          </button>
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">Loading reviewed rows…</p>}
      {data && (
        <>
          <div className="table-wrap">
            <table className="compact">
              <caption className="sr-only">Rows from this exact phone check, with reasons and original fields</caption>
              <thead>
                <tr>
                  <th scope="col">Source row</th>
                  <th scope="col">Best phone</th>
                  <th scope="col">Quality / calling restriction</th>
                  <th scope="col">Combined verdict</th>
                  <th scope="col">Reasons for every phone column</th>
                  <th scope="col">Original and added fields</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(row => (
                  <tr key={row.row_number}>
                    <th scope="row">
                      {row.row_number}
                      {row.raw["Duplicate status"] && (
                        <small className="status-why muted">
                          {row.raw["Duplicate group"] ? `${row.raw["Duplicate group"]} · ` : ""}
                          {row.raw["Duplicate status"]}
                          {row.raw["Duplicate why"] ? `: ${row.raw["Duplicate why"]}` : ""}
                        </small>
                      )}
                      {row.raw["Same owner rows"] && (
                        <small className="status-why muted">Same owner as {String(row.raw["Same owner rows"]).toLowerCase()}</small>
                      )}
                      {(() => {
                        const status = String(row.raw["Duplicate status"] ?? "");
                        const other = Number(/row (\d+)$/.exec(status)?.[1]);
                        if (!other) return null;
                        return said[row.row_number] ? (
                          <small className="status-why" role="status">
                            {said[row.row_number]}
                          </small>
                        ) : (
                          <span className="row overrule">
                            {status.startsWith("Possible") && (
                              <button type="button" className="link" onClick={() => decide(row.row_number, other, true)}>
                                Same lead
                              </button>
                            )}
                            <button type="button" className="link" onClick={() => decide(row.row_number, other, false)}>
                              Not the same lead
                            </button>
                          </span>
                        );
                      })()}
                    </th>
                    <td>{row.raw["Best phone"] || "No usable number"}</td>
                    <td>
                      {row.raw["Best phone quality"] ? (
                        <VerdictPill verdict={row.raw["Best phone quality"] as Verdict} />
                      ) : (
                        <span className="muted">Check again for separate quality</span>
                      )}
                      <p className="muted">
                        {row.raw["Best phone permission"] === "blocked_dnc"
                          ? "Do not call"
                          : row.raw["Best phone permission"] === "no_recorded_block"
                            ? "No recorded block"
                            : ""}
                      </p>
                    </td>
                    <td>
                      {row.raw["Best phone verdict"] ? (
                        <VerdictPill verdict={row.raw["Best phone verdict"] as Verdict} />
                      ) : (
                        <span className="muted">No usable number</span>
                      )}
                    </td>
                    <td>
                      {checkedPhoneColumns(Object.keys(row.raw)).map(column => (
                        <p key={column}>
                          <strong>{column}:</strong> {row.raw[`${column} (verdict)`] || "Empty"} · {row.raw[`${column} (why)`] || "No additional evidence"}
                        </p>
                      ))}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button ghost small"
                        aria-expanded={expanded === row.row_number}
                        onClick={() => setExpanded(expanded === row.row_number ? null : row.row_number)}
                      >
                        All fields
                      </button>
                      {expanded === row.row_number && (
                        <>
                          <PhoneChoices raw={row.raw} datasetId={datasetId} rowNumber={row.row_number} onSaved={onUpdated} />
                          <dl className="review-fields">
                            {Object.entries(row.raw).map(([column, value]) => (
                              <div key={column}>
                                <dt>{column}</dt>
                                <dd>{String(value ?? "–")}</dd>
                              </div>
                            ))}
                          </dl>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.total && <p className="muted">No rows match this view.</p>}
          <footer className="pager">
            <span>{formatNumber(data.total)} matching rows</span>
            <div className="row">
              <button type="button" className="button ghost small" disabled={page === 0} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page + 1} of {Math.max(1, Math.ceil(data.total / 25))}
              </span>
              <button type="button" className="button ghost small" disabled={(page + 1) * 25 >= data.total} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </footer>
        </>
      )}
    </article>
  );
}

export function CheckedPreview({ report }: { report: SkiptraceReport }) {
  const columns = [...new Set(report.preview.flatMap(row => Object.keys(row.raw)))];
  return (
    <div className="table-wrap preview-table">
      <table className="compact">
        <caption>First {report.preview.length} rows of this exact check. Scroll sideways to see every original and added column.</caption>
        <thead>
          <tr>
            <th scope="col">Source row</th>
            {columns.map(column => (
              <th scope="col" key={column}>
                {column}
                {report.added_columns.includes(column) && <small className="muted"> · Added</small>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.preview.map(row => (
            <tr key={row.row_number}>
              <th scope="row">{row.row_number}</th>
              {columns.map(column => (
                <td key={column}>{String(row.raw[column] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
