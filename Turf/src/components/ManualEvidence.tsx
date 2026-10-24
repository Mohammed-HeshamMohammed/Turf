import { useEffect, useState } from "react";
import type { Turf } from "../App";
import { copyText, useContextMenu } from "./ContextMenu";
import { Empty, SearchBox } from "./Bits";
import { markHistory } from "../lib/service";
import { MANUAL_LABELS, formatDate, formatPhone } from "../lib/marks";
import { CallOutcomeLog } from "./PhoneChoices";

export function ManualEvidence({ turf }: { turf: Turf }) {
  const menu = useContextMenu();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<Awaited<ReturnType<typeof markHistory>>>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState(false);
  const [callsOpen, setCallsOpen] = useState(false);
  useEffect(() => {
    if (!showHistory) return;
    let current = true;
    setHistoryError(null);
    markHistory().then(
      value => current && setHistory(value),
      reason => current && setHistoryError(String(reason)),
    );
    return () => {
      current = false;
    };
  }, [showHistory, turf.manual]);
  const entries = Object.entries(turf.manual).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const matches = entries.filter(([number, entry]) => `${number} ${MANUAL_LABELS[entry.mark]}`.toLowerCase().includes(query.toLowerCase()));
  const pages = Math.max(1, Math.ceil(matches.length / 12));
  const current = Math.min(page, pages - 1);
  const legacyCount = Object.keys(turf.legacyManual).length;
  return (
    <details className="card step skiptrace-report">
      <summary>
        <h2>Marks made in Turf</h2>
        <span className="count">{entries.length} in this project</span>
      </summary>
      <div className="skiptrace-report-body">
        <p className="muted">
          Wrong-number, do-not-call, and interested marks are evidence for the next check across this project's lists. Called records activity only. Imported
          and manual evidence keep their sources; conflicting wrong/reached outcomes remain suspicious. Active DNC evidence still blocks the number.
        </p>
        {legacyCount > 0 && !imported && (
          <div className="notice">
            <span>
              {legacyCount} earlier computer-wide marks are still kept in the old store. Import them here if they belong to this project; current project marks
              take precedence.
            </span>
            <button
              type="button"
              className="button ghost"
              disabled={importing}
              onClick={async () => {
                setImporting(true);
                try {
                  await turf.importLegacy();
                  setImported(true);
                } catch (reason) {
                  turf.fail(reason);
                } finally {
                  setImporting(false);
                }
              }}
            >
              Import earlier marks into this project
            </button>
          </div>
        )}
        <SearchBox
          value={query}
          onChange={value => {
            setQuery(value);
            setPage(0);
          }}
          placeholder="Search manual numbers or marks"
        />
        {matches.length ? (
          <ul className="mark-list">
            {matches.slice(current * 12, current * 12 + 12).map(([number, entry]) => (
              <li
                key={number}
                onContextMenu={event =>
                  menu(event, [
                    { label: "Copy the number", onSelect: () => copyText(formatPhone(number)) },
                    { label: "Remove the mark", danger: true, onSelect: () => turf.setMark(number, null) },
                  ])
                }
              >
                <strong>{formatPhone(number)}</strong>
                <span>
                  {MANUAL_LABELS[entry.mark]}
                  {entry.mark === "do_not_call" && entry.until && entry.until < new Date().toISOString().slice(0, 10) ? " · Expired" : ""}
                </span>
                <small>
                  {entry.source ?? "Turf"} · {formatDate(entry.at)}
                </small>
                {entry.mark === "do_not_call" && (
                  <label className="field">
                    <span>DNC end date (optional)</span>
                    <input
                      className="input"
                      type="date"
                      aria-label={`Do-not-call end date for ${number}`}
                      value={entry.until ?? ""}
                      onChange={event => turf.setMark(number, "do_not_call", event.target.value || null)}
                    />
                  </label>
                )}
                <button type="button" className="button ghost small" onClick={() => turf.setMark(number, null)}>
                  Remove mark
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title={entries.length ? "No marks match" : "No marks yet"}>Open a row in Lists to mark its number.</Empty>
        )}
        <div className="pager">
          <span>{matches.length} matching marks</span>
          <div className="row">
            <button type="button" className="button ghost small" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <span>
              {current + 1} / {pages}
            </span>
            <button type="button" className="button ghost small" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>
              Next
            </button>
          </div>
        </div>
        <details onToggle={event => setShowHistory(event.currentTarget.open)}>
          <summary>Mark history, including removed marks</summary>
          {historyError && <p role="alert">{historyError}</p>}
          {showHistory && (
            <div className="table-wrap history-table">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">Number</th>
                    <th scope="col">Change</th>
                    <th scope="col">When</th>
                    <th scope="col">Until</th>
                    <th scope="col">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry, index) => (
                    <tr key={index}>
                      <td>{formatPhone(entry.number)}</td>
                      <td>{entry.mark ? MANUAL_LABELS[entry.mark] : "Removed"}</td>
                      <td>{new Date(entry.at).toLocaleString()}</td>
                      <td>{entry.until ?? "No end date"}</td>
                      <td>{entry.source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
        <details onToggle={event => setCallsOpen(event.currentTarget.open)}>
          <summary>Project call log: dated outcomes and corrections</summary>
          {callsOpen && <CallOutcomeLog onSaved={turf.refresh} />}
        </details>
      </div>
    </details>
  );
}
