import type { ReactNode } from "react";
import { VerdictPill } from "./Bits";
import { regionName } from "../lib/format";
import { formatNumber } from "../lib/marks";
import type { SignReport, SkiptraceReport, Verdict } from "../lib/types";

// Wording follows DataForge's Skip Tracing tab, so the two say the same thing about the same data.
const MEANINGS: { id: Verdict; meaning: string }[] = [
  { id: "wrong", meaning: "Certain: not a real number, made up, marked as a wrong number, or on a do-not-call list." },
  { id: "suspicious", meaning: "Probably bad. The reasons say why." },
  { id: "unverified", meaning: "A real number for its country, and nothing else is known. This is not proof it is connected or belongs to this person." },
  { id: "corroborated", meaning: "A call reached a person here, or independent files agree on it for the same person." },
];

const percent = (share: number | null | undefined, digits = 0) => (share == null ? "–" : `${(share * 100).toFixed(digits)}%`);

function signVerdict(sign: SignReport) {
  if (!sign.enough_data) return "Too few rows to say";
  return sign.predictive ? `${sign.lift}× as often: predicts` : `No clear difference (${sign.lift ?? "–"}×)`;
}

function ReportSection({ id, title, count, children }: { id: string; title: string; count?: ReactNode; children: ReactNode }) {
  return <details className="card step skiptrace-report" id={id}><summary><h2>{title}</h2>{count && <span className="count">{count}</span>}</summary><div className="skiptrace-report-body">{children}</div></details>;
}

type Props = {
  report: SkiptraceReport; datasetId: string;
  showRows: (filter: string, rowNumber?: number) => void;
  busy: boolean; disableApplySigns: boolean;
  onApplySigns: () => void; onUndoSigns: (() => void) | null;
};

/** Report presentation stays separate from the wizard's drafts, running jobs and save controls. */
export function SkiptraceReportDetails({ report, datasetId, showRows, busy, disableApplySigns, onApplySigns, onUndoSigns }: Props) {
  const outcomes = report.outcomes;
  return <>
    {report.phone_assessments && <ReportSection id={`quality-${datasetId}`} title="Phone quality and calling restrictions"><dl className="metrics">{(["corroborated", "unverified", "suspicious", "wrong"] as const).map(quality => <div key={quality}><dt>Quality: {quality}</dt><dd>{formatNumber(report.phone_assessments?.[quality] ?? 0)}</dd></div>)}<div><dt>Active DNC blocks</dt><dd>{formatNumber(report.phone_assessments.blocked_dnc ?? 0)}</dd></div><div><dt>Aging or review warnings</dt><dd>{formatNumber(report.phone_assessments.needs_review ?? 0)}</dd></div></dl><p className="muted">Counts are per-row phone choices. Quality and calling restrictions are separate; a valid number can still be blocked by DNC.</p></ReportSection>}
    <ReportSection id={`verdicts-${datasetId}`} title="Results" count={`${formatNumber(report.values)} phone values`}>

      <div className="verdict-bar" role="img" aria-label={MEANINGS.map(item => `${report.verdicts[item.id]} ${item.id}`).join(", ")}>
        {MEANINGS.map(item => (report.verdicts[item.id] ? <i key={item.id} className={`seg-${item.id}`} style={{ flexGrow: report.verdicts[item.id] }} /> : null))}
      </div>
      <div className="verdict-cards">
        {MEANINGS.map(item => (
          <div key={item.id}>
            <strong>{formatNumber(report.verdicts[item.id])}</strong>
            <VerdictPill verdict={item.id} />
            <small>{percent(report.values ? report.verdicts[item.id] / report.values : 0)} · {item.meaning}</small>
          </div>
        ))}
      </div>
      <dl className="metrics">
        <div><dt>Rows with a usable number</dt><dd>{formatNumber(report.rows_with_callable_number)} <small>of {formatNumber(report.rows)}</small></dd></div>
        <div><dt>Rows with any phone</dt><dd>{formatNumber(report.rows_with_phone)}</dd></div>
        {(outcomes.available || Object.keys(report.manual_evidence).length > 0) && <div><dt>Numbers known wrong</dt><dd>{formatNumber(outcomes.known_wrong_numbers)}</dd></div>}
        {(outcomes.available || Object.keys(report.manual_evidence).length > 0) && <div><dt>Do-not-call numbers</dt><dd>{formatNumber(outcomes.do_not_call_numbers)} <small>{formatNumber(outcomes.expired_do_not_call_numbers)} more expired</small></dd></div>}
      </dl>
      {outcomes.available && outcomes.carried_rows > 0 && (
        <p className="notice" role="status">
          <span>
            <strong>{formatNumber(outcomes.carried_rows)} rows not yet called have a number that is already known to be bad:</strong>{" "}
            {formatNumber(outcomes.carried_wrong_number)} marked wrong number and {formatNumber(outcomes.carried_do_not_call)} on a do-not-call list, in this list or {report.other_datasets_used.length ? report.other_datasets_used.join(", ") : "your other checked lists"}.
            Do not dial these blocked numbers. Review other phone columns in each row for an alternative; the row itself is kept.
          </span>
        </p>
      )}
      {report.other_datasets_used.length > 0 && <p className="muted">Outcomes from {report.other_datasets_used.join(", ")} were used.</p>}
    </ReportSection>

    <ReportSection id={`columns-${datasetId}`} title="Which phone columns are worth using">

      <div className="table-wrap">
        <table className="compact">
          <thead><tr><th scope="col">Column</th><th scope="col" className="num">Filled</th><th scope="col" className="num">Valid</th><th scope="col" className="num">Adds a new number</th><th scope="col" className="num">Wrong</th><th scope="col">Verdict</th></tr></thead>
          <tbody>
            {report.columns.map(column => (
              <tr key={column.column}>
                <th scope="row">{column.column}</th>
                <td className="num">{formatNumber(column.filled)} ({percent(column.filled_share)})</td>
                <td className="num">{percent(column.valid_share)}</td>
                <td className="num">{percent(column.adds_info_share)}</td>
                <td className="num">{formatNumber(column.wrong)}</td>
                <td>{column.verdict_text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportSection>

    {report.reasons.length > 0 && (
      <ReportSection id={`reasons-${datasetId}`} title="Why numbers got their verdict">

        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th scope="col">Reason</th><th scope="col" className="num">Values</th><th scope="col">Examples</th></tr></thead>
            <tbody>
              {report.reasons.map(reason => (
                <tr key={reason.code}>
                  <th scope="row">{reason.label}</th>
                  <td className="num">{formatNumber(reason.count)}</td>
                  <td>
                    {reason.examples.map(example => (
                      <div key={`${example.row}-${example.column}`} className="example"><code>{example.value}</code> <button type="button" className="link" onClick={() => showRows("all", example.row)}>row {example.row}</button>, {example.column}: {example.text}</div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ReportSection>
    )}

    {outcomes.available && (
      <ReportSection id={`signals-${datasetId}`} title="Do the warning signs predict wrong numbers here?">

        <p className="muted">
          Measured on the {formatNumber(outcomes.contacted)} rows where a call either reached a person or found a wrong number. In this data, {percent(outcomes.baseline_wrong_rate, 1)} of those calls were a wrong number.
          A sign is only useful if it is clearly above that.
        </p>
        {report.signals.some(sign => !sign.measured_only && sign.enough_data) && (
          <div className="row">
            <button type="button" className="button ghost" disabled={disableApplySigns} onClick={onApplySigns}>
              Use the signs that predict
            </button>
            <span className="muted">Switches on the signs that clearly predict wrong numbers here and off the ones that do not. Check again afterwards.</span>
          </div>
        )}
        <div className="table-wrap">
          <table className="compact">
            <thead><tr><th scope="col">Sign</th><th scope="col" className="num">Rows</th><th scope="col" className="num">Wrong number rate</th><th scope="col">Compared with all calls</th><th scope="col">Counts as suspicious</th></tr></thead>
            <tbody>
              {report.signals.map(sign => (
                <tr key={sign.code}>
                  <th scope="row">{sign.label}</th>
                  <td className="num">{formatNumber(sign.contacted)}</td>
                  <td className="num">{percent(sign.wrong_rate, 1)}</td>
                  <td>{signVerdict(sign)}</td>
                  <td>{sign.measured_only ? "Measured only" : sign.counted ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ReportSection>
    )}

    {onUndoSigns && <p className="notice" role="status"><span>Predictive signs were applied. Review them in Warning signs and check again.</span><button type="button" className="button ghost" disabled={busy} onClick={onUndoSigns}>Undo sign changes</button></p>}
    <ReportSection id={`phone-details-${datasetId}`} title="What was found in the numbers">

      <dl className="metrics text">
        <div><dt>Kinds of line</dt><dd>{Object.entries(report.types).map(([name, count]) => `${name}: ${formatNumber(count)}`).join(" · ") || "No valid numbers"}</dd></div>
        <div><dt>Countries</dt><dd>{Object.entries(report.countries).map(([code, count]) => `${regionName(code)}: ${formatNumber(count)}`).join(" · ") || "None"}</dd></div>
        {report.repairs.length > 0 && <div><dt>Repaired while reading</dt><dd>{report.repairs.map(repair => `${repair.note}: ${formatNumber(repair.count)}`).join(" · ")}</dd></div>}
      </dl>
      <p className="muted">In the US a landline cannot be told from a mobile, so most come back as “landline or mobile”. The rules check that a number follows its country&apos;s plan, not that it is in service.</p>
    </ReportSection>

  </>;
}
