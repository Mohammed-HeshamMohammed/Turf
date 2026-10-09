import { useEffect, useMemo, useState } from "react";
import type { Turf } from "../App";
import { Check, Empty, Field, VerdictPill } from "../components/Bits";
import { copyText, useContextMenu } from "../components/ContextMenu";
import { Icon } from "../components/Icon";
import { ListPicker } from "../components/ListPicker";
import { knownSuggestion, skiptraceApply, skiptraceSave, skiptraceScan, skiptraceStatuses, skiptraceSuggest } from "../lib/service";
import { useVisited } from "../lib/hooks";
import { MANUAL_LABELS, formatDate, formatNumber, formatPhone } from "../lib/marks";
import type { Dataset, Outcome, SignReport, SkiptraceConfig, SkiptraceReport, SkiptraceSuggestion, StatusRow, Verdict } from "../lib/types";

// Wording follows DataForge's Skip Tracing tab, so the two say the same thing about the same data.
const MEANINGS: { id: Verdict; meaning: string }[] = [
  { id: "wrong", meaning: "Certain: not a real number, made up, marked as a wrong number, or on a do-not-call list." },
  { id: "suspicious", meaning: "Probably bad. The reasons say why." },
  { id: "unverified", meaning: "A real number for its country, and nothing else is known. This is not proof it is connected or belongs to this person." },
  { id: "corroborated", meaning: "A call reached a person here, or independent files agree on it for the same person." },
];

const REGIONS = ["US", "CA", "GB", "IE", "AU", "NZ", "EG", "AE", "SA", "DE", "FR", "ES", "IT", "NL", "IN", "PH", "BR", "MX", "ZA", "NG"];

function regionName(code: string) {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

const percent = (share: number | null | undefined, digits = 0) => (share == null ? "–" : `${(share * 100).toFixed(digits)}%`);

function toggled(outcomes: Outcome[], id: Outcome, on: boolean): Outcome[] {
  const next = on ? [...new Set([...outcomes, id])] : outcomes.filter(item => item !== id);
  // A wrong number is not also a person who was reached.
  return id === "wrong_number" && on ? next.filter(item => item !== "reached") : id === "reached" && on ? next.filter(item => item !== "wrong_number") : next;
}

function signVerdict(sign: SignReport) {
  if (!sign.enough_data) return "Too few rows to say";
  return sign.predictive ? `${sign.lift}× as often: predicts` : `No clear difference (${sign.lift ?? "–"}×)`;
}

function buildConfig(base: SkiptraceConfig, outcomeColumn: string | null, calledColumn: string, statuses: Record<string, Outcome[]>): SkiptraceConfig {
  const called = base.phone_columns.includes(calledColumn) ? calledColumn : base.phone_columns[0];
  const map = Object.fromEntries(Object.entries(statuses).filter(([key, value]) => key && value.length));
  return { ...base, outcome: outcomeColumn && called && Object.keys(map).length ? { column: outcomeColumn, called_column: called, map } : null };
}

export function SkipTracing({ turf }: { turf: Turf }) {
  const selected = turf.datasets.find(item => item.id === turf.selectedId) ?? null;
  // The setup belongs to the list itself; a checked copy points back to it.
  const target = selected?.kind === "checked" ? turf.datasets.find(item => item.id === selected.parent_dataset_id) ?? selected : selected;
  // The setup and results of lists checked lately stay alive, so coming back does not ask the service again.
  const kept = useVisited(target?.id ?? null, turf.datasets.map(item => item.id));
  return (
    <div className="split">
      <ListPicker datasets={turf.datasets.filter(item => item.kind !== "checked")} selectedId={target?.id ?? null} onSelect={turf.select} onImported={async id => { await turf.refresh(); turf.select(id); }}
        menuFor={item => [
          { label: "Check this list", disabled: item.id === target?.id, onSelect: () => turf.select(item.id) },
          { label: "Open in Lists", onSelect: () => turf.open("lists", item.id) },
          { label: "Copy its name", onSelect: () => copyText(item.name) },
        ]} />
      {kept.map(id => (
        <div key={id} className="kept" hidden={id !== target?.id}>
          <Setup turf={turf} dataset={turf.datasets.find(item => item.id === id)!} />
        </div>
      ))}
      {!target && <Empty title="No lists yet">Import a file to check its phone numbers.</Empty>}
    </div>
  );
}

const STEPS = ["Phone columns", "Call outcomes", "Warning signs", "Results", "Save the copy"];

const calledOf = (suggestion: SkiptraceSuggestion) => suggestion.config.outcome?.called_column ?? suggestion.config.phone_columns[0] ?? "";
const meaningOf = (suggestion: SkiptraceSuggestion) => Object.fromEntries(suggestion.statuses.map(status => [status.key, status.outcomes]));

function Setup({ turf, dataset }: { turf: Turf; dataset: Dataset }) {
  // When the setup was fetched ahead of time, the screen starts filled in and never shows a loading line.
  const [known] = useState(() => knownSuggestion(dataset.id));
  const [setup, setSetup] = useState<SkiptraceSuggestion | null>(known);
  const [base, setBase] = useState<SkiptraceConfig | null>(known?.config ?? null);
  const [outcomeColumn, setOutcomeColumn] = useState<string | null>(known?.outcome_column ?? null);
  const [called, setCalled] = useState(known ? calledOf(known) : "");
  const [statuses, setStatuses] = useState<StatusRow[]>(known?.statuses ?? []);
  const [meaning, setMeaning] = useState<Record<string, Outcome[]>>(known ? meaningOf(known) : {});
  const [more, setMore] = useState(false);
  const menu = useContextMenu();
  // One step is on screen at a time; the others keep what was entered in them.
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<"scan" | "apply" | null>(null);
  const [report, setReport] = useState<SkiptraceReport | null>(null);
  const [scannedWith, setScannedWith] = useState<string | null>(null);
  const [copyName, setCopyName] = useState("");
  const [saved, setSaved] = useState<{ dataset_id: string; rows: number; added_columns: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copy = turf.datasets.find(item => item.kind === "checked" && item.parent_dataset_id === dataset.id) ?? null;

  useEffect(() => {
    // Already filled in from a setup that arrived earlier (see the initial state above).
    if (known) return;
    let current = true;
    skiptraceSuggest(dataset.id).then(result => {
      if (!current) return;
      setSetup(result);
      setBase(result.config);
      setOutcomeColumn(result.outcome_column);
      setCalled(calledOf(result));
      setStatuses(result.statuses);
      setMeaning(meaningOf(result));
    }).catch(reason => current && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { current = false; };
  }, [dataset.id, known]);

  const config = useMemo(() => (base ? buildConfig(base, outcomeColumn, called, meaning) : null), [base, outcomeColumn, called, meaning]);
  const configKey = JSON.stringify(config);
  const stale = Boolean(report) && scannedWith !== configKey;

  const outcomeColumns = useMemo(() => {
    if (!setup) return [];
    const preferred = setup.outcome_candidates.map(item => item.column);
    return [...preferred, ...setup.columns.filter(column => !preferred.includes(column))];
  }, [setup]);

  if (!setup || !base || !config) return error ? <p className="notice" role="alert">{error}</p> : <p className="loading">Reading the setup…</p>;

  const columnOptions = setup.columns.map(column => ({ value: column, label: column }));
  const patch = (changes: Partial<SkiptraceConfig>) => setBase({ ...base, ...changes });
  const togglePhone = (column: string, on: boolean) => {
    const columns = on ? [...base.phone_columns, column] : base.phone_columns.filter(item => item !== column);
    patch({ phone_columns: columns });
    if (!columns.includes(called)) setCalled(columns[0] ?? "");
  };

  async function chooseOutcomeColumn(column: string | null) {
    setOutcomeColumn(column);
    if (!column) { setStatuses([]); setMeaning({}); return; }
    const table = await skiptraceStatuses(dataset.id, column, base!.region);
    setStatuses(table);
    setMeaning(Object.fromEntries(table.map(status => [status.key, status.outcomes])));
  }

  async function check() {
    setBusy("scan");
    setError(null);
    setSaved(null);
    try {
      // The setup is kept with the list, so its call outcomes can warn about numbers in other lists.
      await skiptraceSave(dataset.id, config!);
      setReport((await skiptraceScan(dataset.id, config!)).report);
      setScannedWith(configKey);
      setStep(3);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setBusy(null);
  }

  async function saveCopy() {
    setBusy("apply");
    setError(null);
    try {
      const result = await skiptraceApply(dataset.id, config!, copyName.trim() || undefined);
      await turf.refresh();
      setSaved(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setBusy(null);
  }

  const marks = Object.entries(turf.manual).sort((a, b) => b[1].at.localeCompare(a[1].at));
  const outcomes = report?.outcomes;
  const hasPhones = base.phone_columns.length > 0;
  // The setup steps open once a phone column is chosen; the results and the saving once there is a check to show.
  const reachable = (index: number) => index === 0 || (index <= 2 ? hasPhones : Boolean(report));

  return (
    <section className="list-view skiptrace">
      <header className="list-head">
        <div>
          <h1>{dataset.name}</h1>
          <p>
            {formatNumber(setup.rows)} rows · {setup.saved ? "Setup saved with this list" : "Setup proposed from the columns"}
            {copy && <> · <button type="button" className="link" onClick={() => turf.open("lists", copy.id)}>Open the checked copy</button></>}
          </p>
        </div>
      </header>
      <p className="lede">
        Checks whether the phone numbers in a list can be trusted, and which phone columns are worth using. A number that follows its country&apos;s numbering plan is only
        unverified: that is not proof it is connected or belongs to this person. The original rows are never changed.
      </p>
      {error && <p className="notice" role="alert">{error}</p>}

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button type="button" disabled={!reachable(index)} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>
              <b>{index + 1}</b>{label}
            </button>
          </li>
        ))}
      </ol>

      <div className="wizard-step" hidden={step !== 0}>
      <article className="card step">
        <header><h2>Which columns hold phone numbers</h2></header>
        {!setup.config.phone_columns.length && <p className="notice">No column in this list looks like it holds phone numbers. Tick the ones that do, if any.</p>}
        <div className="checks">
          {setup.columns.map(column => <Check key={column} checked={base.phone_columns.includes(column)} onChange={on => togglePhone(column, on)}>{column}</Check>)}
        </div>
        <div className="fields">
          <Field label="Country to assume when a number does not say" value={base.region} searchable onChange={region => patch({ region: region ?? "US" })}
            options={REGIONS.map(code => ({ value: code, label: `${regionName(code)} (${code})` }))} />
          <Field label="Country column (optional: its country wins for that row)" value={base.country_column} optional="None" options={columnOptions} onChange={country_column => patch({ country_column })} />
        </div>
        <button type="button" className="disclosure" aria-expanded={more} onClick={() => setMore(!more)}>
          <Icon name="chevron" size={16} />Columns that help find shared numbers and areas (optional)
        </button>
        {more && (
          <div className="fields">
            <Field label="First name" value={base.first_name_column} optional="None" options={columnOptions} onChange={first_name_column => patch({ first_name_column })} />
            <Field label="Last name" value={base.last_name_column} optional="None" options={columnOptions} onChange={last_name_column => patch({ last_name_column })} />
            <Field label="Full name (if there is no first and last)" value={base.name_column} optional="None" options={columnOptions} onChange={name_column => patch({ name_column })} />
            <Field label="ZIP or postal code" value={base.zip_column} optional="None" options={columnOptions} onChange={zip_column => patch({ zip_column })} />
            <Field label="State" value={base.state_column} optional="None" options={columnOptions} onChange={state_column => patch({ state_column })} />
          </div>
        )}
        {!hasPhones && <p className="muted">Choose at least one phone column to go on.</p>}
      </article>
      </div>

      <div className="wizard-step" hidden={step !== 1}>
      <article className="card step">
        <header><h2>Call outcomes (recommended)</h2></header>
        <p className="muted">
          If this list records what happened on each call, a wrong number or a do-not-call in one row warns about the same number in every other row and in your other checked lists.
          Say once what each status means. A do-not-call mark with an end date stops counting after that date.
        </p>
        <div className="fields">
          <Field label="Status column" value={outcomeColumn} optional="No outcome column" options={outcomeColumns.map(column => ({ value: column, label: column }))} onChange={column => void chooseOutcomeColumn(column)} />
          {outcomeColumn && base.phone_columns.length > 0 && (
            <Field label="The status describes the call to" value={called} options={base.phone_columns.map(column => ({ value: column, label: column }))} onChange={column => setCalled(column ?? "")} />
          )}
        </div>
        {outcomeColumn && statuses.length > 0 && (
          <div className="table-wrap">
            <table className="compact">
              <caption className="sr-only">What each status means</caption>
              <thead>
                <tr><th scope="col">Status</th><th scope="col" className="num">Rows</th>{setup.outcomes.map(outcome => <th scope="col" key={outcome.id} className="center">{outcome.label}</th>)}</tr>
              </thead>
              <tbody>
                {statuses.map(status => (
                  <tr key={status.key}>
                    <th scope="row">{status.example}</th>
                    <td className="num">{formatNumber(status.count)}</td>
                    {setup.outcomes.map(outcome => (
                      <td key={outcome.id} className="center">
                        <Check label={`${status.example}: ${outcome.label}`} checked={(meaning[status.key] ?? []).includes(outcome.id)}
                          onChange={on => setMeaning({ ...meaning, [status.key]: toggled(meaning[status.key] ?? [], outcome.id, on) })} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
      </div>

      <div className="wizard-step" hidden={step !== 2}>
      <article className="card step">
        <header><h2>Warning signs</h2></header>
        <p className="muted">These make a number suspicious. With call outcomes, the results show how well each one predicts a wrong number in your own data, so you can switch off the ones that do not.</p>
        <div className="checks column">
          {setup.signals.filter(sign => !sign.measured_only).map(sign => (
            <Check key={sign.code} checked={Boolean(base.signals[sign.code])} onChange={on => patch({ signals: { ...base.signals, [sign.code]: on } })}>{sign.label}</Check>
          ))}
        </div>
        <p className="muted">The next step reads every phone number in the list. Nothing is saved until the last step.</p>
      </article>
      </div>

      {report && outcomes && (
        <>
          <div className="wizard-step" hidden={step !== 3}>
          {stale && (
            <p className="notice" role="status">
              <span>You changed the setup after this check, so these results are out of date.</span>
              <button type="button" className="button" disabled={busy !== null} onClick={() => void check()}>{busy === "scan" ? "Checking…" : "Check again"}</button>
            </p>
          )}

          <article className="card step">
            <header><h2>Results</h2><span className="count">{formatNumber(report.values)} phone values</span></header>
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
              {outcomes.available && <div><dt>Numbers known wrong</dt><dd>{formatNumber(outcomes.known_wrong_numbers)}</dd></div>}
              {outcomes.available && <div><dt>Do-not-call numbers</dt><dd>{formatNumber(outcomes.do_not_call_numbers)} <small>{formatNumber(outcomes.expired_do_not_call_numbers)} more expired</small></dd></div>}
            </dl>
            {outcomes.available && outcomes.carried_rows > 0 && (
              <p className="notice" role="status">
                <span>
                  <strong>{formatNumber(outcomes.carried_rows)} rows not yet called have a number that is already known to be bad:</strong>{" "}
                  {formatNumber(outcomes.carried_wrong_number)} marked wrong number and {formatNumber(outcomes.carried_do_not_call)} on a do-not-call list, in this list or {report.other_datasets_used.length ? report.other_datasets_used.join(", ") : "your other checked lists"}.
                  Take these off the call list before anyone dials them.
                </span>
              </p>
            )}
            {report.other_datasets_used.length > 0 && <p className="muted">Outcomes from {report.other_datasets_used.join(", ")} were used.</p>}
          </article>

          <article className="card step">
            <header><h2>Which phone columns are worth using</h2></header>
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
          </article>

          {report.reasons.length > 0 && (
            <article className="card step">
              <header><h2>Why numbers got their verdict</h2></header>
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
                            <div key={`${example.row}-${example.column}`} className="example"><code>{example.value}</code> row {example.row}, {example.column}: {example.text}</div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          )}

          {outcomes.available && (
            <article className="card step">
              <header><h2>Do the warning signs predict wrong numbers here?</h2></header>
              <p className="muted">
                Measured on the {formatNumber(outcomes.contacted)} rows where a call either reached a person or found a wrong number. In this data, {percent(outcomes.baseline_wrong_rate, 1)} of those calls were a wrong number.
                A sign is only useful if it is clearly above that.
              </p>
              {report.signals.some(sign => !sign.measured_only && sign.enough_data) && (
                <div className="row">
                  <button type="button" className="button ghost" onClick={() => patch({ signals: { ...base.signals, ...Object.fromEntries(report.signals.filter(sign => !sign.measured_only && sign.enough_data).map(sign => [sign.code, sign.predictive])) } })}>
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
            </article>
          )}

          <article className="card step">
            <header><h2>What was found in the numbers</h2></header>
            <dl className="metrics text">
              <div><dt>Kinds of line</dt><dd>{Object.entries(report.types).map(([name, count]) => `${name}: ${formatNumber(count)}`).join(" · ") || "No valid numbers"}</dd></div>
              <div><dt>Countries</dt><dd>{Object.entries(report.countries).map(([code, count]) => `${regionName(code)}: ${formatNumber(count)}`).join(" · ") || "None"}</dd></div>
              {report.repairs.length > 0 && <div><dt>Repaired while reading</dt><dd>{report.repairs.map(repair => `${repair.note}: ${formatNumber(repair.count)}`).join(" · ")}</dd></div>}
            </dl>
            <p className="muted">In the US a landline cannot be told from a mobile, so most come back as “landline or mobile”. The rules check that a number follows its country&apos;s plan, not that it is in service.</p>
          </article>

          </div>

          <div className="wizard-step" hidden={step !== 4}>
          <article className="card step">
            <header><h2>Save the checked copy</h2></header>
            <p className="muted">
              Adds, for each phone column, its verdict, the reasons, the number in international format and the kind of line, plus the best number to call in each row.
              It is saved as a new list next to the original{copy ? `, replacing ${copy.name}` : ""}.
            </p>
            <label className="field">
              <span>Name of the checked copy</span>
              <input className="input" value={copyName} placeholder={copy?.name ?? `${dataset.name} (phones checked)`} onChange={event => setCopyName(event.target.value)} />
            </label>
            <div className="row">
              <button type="button" className="button" disabled={busy !== null || stale} onClick={() => void saveCopy()}>{busy === "apply" ? "Saving…" : "Save checked copy"}</button>
              {stale && <span className="muted">Check again first: the setup changed.</span>}
            </div>
            {saved && (
              <p className="notice good" role="status">
                <span>Saved {formatNumber(saved.rows)} rows with {saved.added_columns.length} new columns.</span>
                <button type="button" className="button" onClick={() => turf.open("lists", saved.dataset_id)}>Open in Lists</button>
              </p>
            )}
          </article>
          </div>
        </>
      )}

      <div className="wizard-step" hidden={step !== 3}>
      <article className="card step">
        <header><h2>Marks made in Turf</h2><span className="count">{marks.length}</span></header>
        {marks.length ? (
          <ul className="mark-list">
            {marks.slice(0, 12).map(([number, entry]) => (
              <li key={number} onContextMenu={event => menu(event, [
                { label: "Copy the number", hint: formatPhone(number), onSelect: () => copyText(formatPhone(number)) },
                { label: "Remove the mark", danger: true, onSelect: () => turf.setMark(number, null) },
              ])}>
                <strong>{formatPhone(number)}</strong>
                <span className={`pill ${entry.mark === "interested" ? "pill-corroborated" : entry.mark === "called" ? "pill-none" : "pill-wrong"}`}>{MANUAL_LABELS[entry.mark]}</span>
                <small>{formatDate(entry.at)}</small>
                <button type="button" className="round small" aria-label={`Remove the mark on ${formatPhone(number)}`} onClick={() => turf.setMark(number, null)}><Icon name="close" size={14} /></button>
              </li>
            ))}
          </ul>
        ) : <Empty title="No marks yet">Open a row in Lists and mark its number: called, interested, wrong number or do not call.</Empty>}
        {marks.length > 12 && <p className="muted">{marks.length - 12} more not shown.</p>}
        <p className="muted">Turf keeps these on this computer. They show on rows in Lists, but the phone check above does not read them yet.</p>
      </article>
      </div>

      <footer className="wizard-nav">
        <button type="button" className="button ghost" disabled={step === 0 || busy !== null} onClick={() => setStep(step - 1)}>Back</button>
        <span className="muted">Step {step + 1} of {STEPS.length}: {STEPS[step]}</span>
        {step < 2 && <button type="button" className="button" disabled={!hasPhones} onClick={() => setStep(step + 1)}>Next</button>}
        {step === 2 && (
          <div className="row">
            {report && !stale && <button type="button" className="button ghost" onClick={() => setStep(3)}>See the last results</button>}
            <button type="button" className="button" disabled={!hasPhones || busy !== null} onClick={() => void check()}>
              {busy === "scan" ? "Checking…" : report ? "Check again" : "Check phone numbers"}
            </button>
          </div>
        )}
        {step === 3 && <button type="button" className="button" disabled={stale || busy !== null} onClick={() => setStep(4)}>Next</button>}
        {step === 4 && <span />}
      </footer>
    </section>
  );
}
