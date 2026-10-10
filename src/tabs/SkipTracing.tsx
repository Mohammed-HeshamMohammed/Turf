import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Turf } from "../App";
import { Check, Empty, Field, SearchBox, VerdictPill } from "../components/Bits";
import { copyText } from "../components/ContextMenu";
import { ListPicker } from "../components/ListPicker";
import { ListDownloads } from "../components/ListDownloads";
import { PhoneLookup } from "../components/PhoneLookup";
import { DialerEvidence } from "../components/DialerEvidence";
import { cancelSkiptraceJob, knownSuggestion, skiptraceFreshness, skiptraceApply, skiptraceSave, skiptraceScan, skiptraceStatuses, skiptraceSuggest, watchJob } from "../lib/service";
import { useVisited } from "../lib/hooks";
import { formatNumber } from "../lib/marks";
import { ManualEvidence } from "../components/ManualEvidence";
import { CheckedPreview, SkiptraceReview } from "../components/SkiptraceReview";
import { SkiptraceTemplates } from "../components/SkiptraceTemplates";
import { SkiptraceColumns } from "../components/SkiptraceColumns";
import { checkedCopies, missingColumns, readDraft, SIGN_HELP, STAGE_LABELS, statusPage, stableKey, type WorkflowDraft } from "../lib/skiptrace-workflow";
import type { Dataset, Outcome, SignReport, SkiptraceConfig, SkiptraceReport, SkiptraceSuggestion, StatusRow, Verdict } from "../lib/types";

// Wording follows DataForge's Skip Tracing tab, so the two say the same thing about the same data.
const MEANINGS: { id: Verdict; meaning: string }[] = [
  { id: "wrong", meaning: "Certain: not a real number, made up, marked as a wrong number, or on a do-not-call list." },
  { id: "suspicious", meaning: "Probably bad. The reasons say why." },
  { id: "unverified", meaning: "A real number for its country, and nothing else is known. This is not proof it is connected or belongs to this person." },
  { id: "corroborated", meaning: "A call reached a person here, or independent files agree on it for the same person." },
];

const REGIONS = ["US", "CA", "GB", "IE", "AU", "NZ", "EG", "AE", "SA", "DE", "FR", "ES", "IT", "NL", "IN", "PH", "BR", "MX", "ZA", "NG"];
const PHONE_COLUMN_NAME = /phone|mobile|cell|tel(?!l)|fax|whatsapp|contact number|landline|gsm|celular|m[oó]vil|portable|handy|هاتف|موبايل|جوال|تليفون|محمول/i;
const IDENTIFIER_COLUMN_NAME = /\b(?:id|identifier|apn|parcel|account|property|mls|tax|zip|postal|ssn)\b/i;

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
  const negative = ["wrong_number", "wrong_person", "disconnected"];
  return negative.includes(id) && on ? next.filter(item => item !== "reached") : id === "reached" && on ? next.filter(item => !negative.includes(item)) : next;
}

function signVerdict(sign: SignReport) {
  if (!sign.enough_data) return "Too few rows to say";
  return sign.predictive ? `${sign.lift}× as often: predicts` : `No clear difference (${sign.lift ?? "–"}×)`;
}

function buildConfig(base: SkiptraceConfig, outcomeColumn: string | null, calledColumn: string, statuses: Record<string, Outcome[]>, reviewed: string[] = []): SkiptraceConfig {
  const called = base.phone_columns.includes(calledColumn) ? calledColumn : base.phone_columns[0];
  const map = Object.fromEntries(Object.entries(statuses).filter(([key, value]) => key && (value.length || reviewed.includes(key))));
  return { ...base, outcome: outcomeColumn && called && Object.keys(map).length ? { column: outcomeColumn, called_column: called, map } : null };
}

export function SkipTracing({ turf }: { turf: Turf }) {
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const selected = turf.datasets.find(item => item.id === turf.selectedId) ?? null;
  // The setup belongs to the list itself; a checked copy points back to it.
  const target = selected?.kind === "checked" ? turf.datasets.find(item => item.id === selected.parent_dataset_id) ?? selected : selected;
  // The setup and results of lists checked lately stay alive, so coming back does not ask the service again.
  const kept = useVisited(target?.id ?? null, turf.datasets.map(item => item.id));
  return (
    <div className="split skiptrace-workspace">
      <button type="button" className="button ghost skiptrace-list-toggle" aria-expanded={listPickerOpen} aria-controls="skiptrace-list-picker" onClick={() => setListPickerOpen(open => !open)}>
        {listPickerOpen ? "Close lists" : `Switch list${target ? ` · ${target.name}` : ""}`}
      </button>
      <div id="skiptrace-list-picker" className="skiptrace-list-rail" data-open={listPickerOpen}>
      <ListPicker datasets={turf.datasets.filter(item => item.kind !== "checked")} selectedId={target?.id ?? null} onSelect={id => { turf.select(id); setListPickerOpen(false); }} onImported={async id => { await turf.refresh(); turf.select(id); setListPickerOpen(false); }}
        menuFor={item => [
          { label: "Check this list", disabled: item.id === target?.id, onSelect: () => turf.select(item.id) },
          { label: "Open in Lists", onSelect: () => turf.open("lists", item.id) },
          { label: "Copy its name", onSelect: () => copyText(item.name) },
        ]} />
      </div>
      {kept.map(id => (
        <div key={id} className="kept" hidden={id !== target?.id}>
          <Setup turf={turf} dataset={turf.datasets.find(item => item.id === id)!} />
        </div>
      ))}
      {!target && <Empty title="No lists yet">Import a file to check its phone numbers.</Empty>}
    </div>
  );
}

const STEPS = ["Column roles", "Call outcomes", "Warning signs", "Results", "Save the copy"];

function ReportSection({ id, title, count, children }: { id: string; title: string; count?: ReactNode; children: ReactNode }) {
  return <details className="card step skiptrace-report" id={id}><summary><h2>{title}</h2>{count && <span className="count">{count}</span>}</summary><div className="skiptrace-report-body">{children}</div></details>;
}

function scrollInPane(target: HTMLElement | null | undefined) {
  const pane = target?.closest<HTMLElement>(".scroller");
  if (pane && target) pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
}

const calledOf = (suggestion: SkiptraceSuggestion) => suggestion.config.outcome?.called_column ?? suggestion.config.phone_columns[0] ?? "";
const meaningOf = (suggestion: SkiptraceSuggestion) => Object.fromEntries(suggestion.statuses.map(status => [status.key, status.outcomes]));

function Setup({ turf, dataset }: { turf: Turf; dataset: Dataset }) {
  const draftKey = `turf.skiptrace.draft.${turf.projectId}.${dataset.id}`;
  const view = useRef<HTMLElement>(null);
  const [draft] = useState(() => readDraft(draftKey));
  const [known] = useState(() => knownSuggestion(dataset.id));
  const [setup, setSetup] = useState<SkiptraceSuggestion | null>(known);
  const [base, setBase] = useState<SkiptraceConfig | null>(draft?.base ?? known?.config ?? null);
  const [outcomeColumn, setOutcomeColumn] = useState<string | null>(draft ? draft.outcomeColumn : known?.outcome_column ?? null);
  const [called, setCalled] = useState(draft?.called ?? (known ? calledOf(known) : ""));
  const [statuses, setStatuses] = useState<StatusRow[]>(known?.statuses ?? []);
  const [meaning, setMeaning] = useState<Record<string, Outcome[]>>(draft?.meaning ?? (known ? meaningOf(known) : {}));
  const [reviewed, setReviewed] = useState<string[]>(draft?.reviewed ?? known?.statuses.filter(item => item.confirmed).map(item => item.key) ?? []);
  const [confirmedIdentifierColumns, setConfirmedIdentifierColumns] = useState<string[]>([]);
  const [step, setStep] = useState(Math.min(4, Math.max(0, draft?.step ?? 0)));
  const previousStep = useRef(step);
  const [busy, setBusy] = useState<"scan" | "apply" | null>(draft?.activeJob?.kind ?? null);
  const [activeJob, setActiveJob] = useState<WorkflowDraft["activeJob"]>(draft?.activeJob ?? null);
  const [statusBusy, setStatusBusy] = useState(false);
  const statusRequest = useRef(0);
  const [report, setReport] = useState<SkiptraceReport | null>(draft?.report ?? null);
  const [scannedWith, setScannedWith] = useState<string | null>(draft?.scannedWith ?? null);
  const [savedConfigKey, setSavedConfigKey] = useState<string | null>(known?.saved ? stableKey(known.config) : null);
  const [copyName, setCopyName] = useState(draft?.copyName ?? "");
  const [saved, setSaved] = useState<{ dataset_id: string; rows: number; added_columns: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [freshnessError, setFreshnessError] = useState<string | null>(null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(draft?.activeJob?.id ?? null);
  const [stage, setStage] = useState<{ stage: string; completed?: number; total?: number }>({ stage: draft?.activeJob ? "recovering" : "saving_setup" });
  const [stopping, setStopping] = useState(false);
  const [statusQuery, setStatusQuery] = useState("");
  const [unreviewedOnly, setUnreviewedOnly] = useState(false);
  const [statusPageIndex, setStatusPageIndex] = useState(0);
  const [reviewFilter, setReviewFilter] = useState("all");
  const [reviewRow, setReviewRow] = useState<number | undefined>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [importingLegacy, setImportingLegacy] = useState(false);
  const [legacyImported, setLegacyImported] = useState(false);
  const [previousSignals, setPreviousSignals] = useState<Record<string, boolean> | null>(null);
  const [mappingMessage, setMappingMessage] = useState<string | null>(null);
  const [advancedLookup, setAdvancedLookup] = useState(false);
  const [dialerOpen, setDialerOpen] = useState(false);
  const copies = checkedCopies(turf.datasets, dataset.id);
  const copy = copies[0] ?? null;

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const result = known ?? await skiptraceSuggest(dataset.id);
        if (!current) return;
        setSetup(result);
        if (result.saved) setSavedConfigKey(stableKey(result.config));
        if (!draft) {
          setBase(result.config); setOutcomeColumn(result.outcome_column); setCalled(calledOf(result));
          setStatuses(result.statuses); setMeaning(meaningOf(result));
          setReviewed(result.statuses.filter(item => item.confirmed).map(item => item.key));
        } else if (draft.outcomeColumn && result.columns.includes(draft.outcomeColumn)) {
          setStatusBusy(true);
          const table = await skiptraceStatuses(dataset.id, draft.outcomeColumn, draft.base.region);
          if (!current) return;
          setStatuses(table);
          setMeaning(Object.fromEntries(table.map(item => [item.key, draft.meaning[item.key] ?? item.outcomes])));
        } else setStatuses([]);
      } catch (reason) { if (current) setError(reason instanceof Error ? reason.message : String(reason)); }
      finally { if (current) setStatusBusy(false); }
    }
    void load();
    return () => { current = false; statusRequest.current += 1; };
  }, [dataset.id, known, draft]);

  useEffect(() => {
    if (!view.current || view.current.closest("[hidden]")) return;
    if (previousStep.current !== step) {
      scrollInPane(view.current.querySelector<HTMLElement>(".stepper"));
      previousStep.current = step;
    }
    const heading = view.current.querySelector<HTMLElement>(".wizard-step:not([hidden]) h2");
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }, [step, Boolean(setup)]);

  useEffect(() => {
    const reveal = () => {
      const strip = view.current?.querySelector<HTMLElement>(".stepper");
      const selected = strip?.querySelector<HTMLElement>('[aria-current="step"]');
      if (!strip || !selected) return;
      const bounds = strip.getBoundingClientRect(), button = selected.getBoundingClientRect();
      if (button.right > bounds.right) strip.scrollLeft += button.right - bounds.right + 8;
      else if (button.left < bounds.left) strip.scrollLeft -= bounds.left - button.left + 8;
    };
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [step, Boolean(setup)]);

  const config = useMemo(() => (base ? buildConfig(base, outcomeColumn, called, meaning, reviewed) : null), [base, outcomeColumn, called, meaning, reviewed]);
  const configKey = stableKey(config);
  const staleSetup = Boolean(report) && scannedWith !== configKey;
  const staleEvidence = Boolean(report && fingerprint && report.fingerprint !== fingerprint);
  const stale = staleSetup || staleEvidence;
  const freshnessPending = Boolean(report) && !fingerprint;
  useEffect(() => {
    if (!report) return;
    let current = true;
    setFingerprint(null);
    const check = () => skiptraceFreshness(dataset.id).then(value => {
      if (current) { setFingerprint(value.fingerprint); setFreshnessError(null); }
    }, reason => { if (current) { setFingerprint(null); setFreshnessError(String(reason)); } });
    void check();
    const interval = window.setInterval(() => void check(), 30_000);
    const focus = () => void check();
    window.addEventListener("focus", focus);
    return () => { current = false; window.clearInterval(interval); window.removeEventListener("focus", focus); };
  }, [report?.fingerprint, dataset.id, turf.version, turf.manual]);

  useEffect(() => {
    if (!draft?.activeJob) return;
    const active = draft.activeJob;
    let current = true;
    const watch = { onEvent: (event: Record<string, unknown>) => {
      if (current && typeof event.stage === "string") setStage({ stage: event.stage, completed: typeof event.completed === "number" ? event.completed : undefined, total: typeof event.total === "number" ? event.total : undefined });
    } };
    async function resume() {
      try {
        if (active.kind === "scan") {
          const result = await watchJob<{ report: SkiptraceReport }>(active.id, watch);
          if (current) { setReport(result.report); setScannedWith(active.configKey); setFingerprint(result.report.fingerprint); setStep(3); }
        } else {
          const result = await watchJob<{ dataset_id: string; rows: number; added_columns: string[] }>(active.id, watch);
          if (current) { await turf.refresh(); setSaved(result); setStep(4); }
        }
      } catch (reason) { if (current) setError(String(reason)); }
      finally { if (current) { setBusy(null); setActiveJob(null); setJobId(null); } }
    }
    void resume();
    return () => { current = false; };
  }, [draft]);

  useEffect(() => {
    if (!setup || !base || statusBusy) return;
    const state: WorkflowDraft = { base, outcomeColumn, called, meaning, reviewed, step, copyName, report, scannedWith, activeJob };
    try { localStorage.setItem(draftKey, JSON.stringify({ version: 1, state })); setDraftError(null); }
    catch { setDraftError("Your draft could not be saved on this computer. Keep this tab open; storage may be full or unavailable."); }
  }, [setup, base, outcomeColumn, called, meaning, reviewed, step, copyName, report, scannedWith, draftKey, statusBusy, activeJob]);

  const outcomeColumns = useMemo(() => {
    if (!setup) return [];
    const preferred = setup.outcome_candidates.map(item => item.column);
    return [...preferred, ...setup.columns.filter(column => !preferred.includes(column))];
  }, [setup]);
  const statusView = statusPage(statuses, statusQuery, unreviewedOnly, reviewed, statusPageIndex);
  const unreviewed = statuses.filter(item => !reviewed.includes(item.key));
  const ignored = statuses.filter(item => reviewed.includes(item.key) && !(meaning[item.key]?.length));

  if (!setup || !base || !config) return error ? <p className="notice" role="alert">{error}</p> : <p className="loading">Reading the setup…</p>;
  const missing = missingColumns(config, setup.columns);
  const columnOptions = setup.columns.map(column => ({ value: column, label: column, description: (setup.column_samples[column] ?? []).join(" · ") }));
  const patch = (changes: Partial<SkiptraceConfig>) => setBase({ ...base, ...changes });
  const mapColumns = (next: SkiptraceConfig) => {
    setConfirmedIdentifierColumns(current => current.filter(column => next.phone_columns.includes(column)));
    setBase(next);
    if (!next.phone_columns.includes(called)) setCalled(next.phone_columns[0] ?? "");
  };

  async function chooseOutcomeColumn(column: string | null, region = base!.region) {
    const request = ++statusRequest.current;
    setStatusBusy(true); setError(null);
    try {
      const table = column ? await skiptraceStatuses(dataset.id, column, region) : [];
      if (request !== statusRequest.current) return;
      setOutcomeColumn(column); setStatuses(table);
      setMeaning(Object.fromEntries(table.map(status => [status.key, status.outcomes])));
      setReviewed([]); setStatusPageIndex(0);
    } catch (reason) { if (request === statusRequest.current) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (request === statusRequest.current) setStatusBusy(false); }
  }
  async function changeRegion(region: string) {
    if (region === base!.region) return;
    // Changing date interpretation must not retain status keys from another country's format.
    if (outcomeColumn) {
      setStatusBusy(true);
      try {
        const table = await skiptraceStatuses(dataset.id, outcomeColumn, region);
        setBase({ ...base!, region }); setStatuses(table);
        setMeaning(Object.fromEntries(table.map(status => [status.key, meaning[status.key] ?? status.outcomes])));
        setReviewed(reviewed.filter(key => table.some(item => item.key === key)));
      } catch (reason) { setError(String(reason)); }
      finally { setStatusBusy(false); }
    } else patch({ region });
  }
  async function applyTemplate(next: SkiptraceConfig) {
    setStatusBusy(true);
    try {
      const column = next.outcome?.column ?? null;
      const table = column ? await skiptraceStatuses(dataset.id, column, next.region) : [];
      setBase(next); setOutcomeColumn(column); setCalled(next.outcome?.called_column ?? next.phone_columns[0] ?? "");
      setStatuses(table); setMeaning(Object.fromEntries(table.map(item => [item.key, next.outcome?.map[item.key] ?? item.outcomes])));
      setReviewed([]); setStep(0); setStatusPageIndex(0);
    } finally { setStatusBusy(false); }
  }
  const watch = (kind: "scan" | "apply") => ({
    onStart: (id: string) => {
      setJobId(id);
      const active = { id, kind, configKey };
      setActiveJob(active);
      try {
        const current = readDraft(draftKey);
        if (current) localStorage.setItem(draftKey, JSON.stringify({ version: 1, state: { ...current, activeJob: active } }));
      } catch { setDraftError("The running job could not be saved for recovery. Keep this tab open."); }
    },
    onEvent: (event: Record<string, unknown>) => { if (typeof event.stage === "string") setStage({ stage: event.stage, completed: typeof event.completed === "number" ? event.completed : undefined, total: typeof event.total === "number" ? event.total : undefined }); },
  });
  async function check() {
    if (busy || statusBusy || importingLegacy || !hasPhones) return;
    setBusy("scan"); setError(null); setSaved(null); setJobId(null); setStopping(false); setStage({ stage: "saving_setup" });
    try {
      await skiptraceSave(dataset.id, config!);
      setSavedConfigKey(configKey);
      const result = await skiptraceScan(dataset.id, config!, watch("scan"));
      setReport(result.report); setFingerprint(result.report.fingerprint); setScannedWith(configKey); setStep(3);
      setReviewOpen(false); setReviewFilter("all"); setReviewRow(undefined);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); setActiveJob(null); setJobId(null); setStopping(false); }
  }
  async function saveCopy() {
    if (busy || !report || stale || freshnessPending || !hasPhones) return;
    setBusy("apply"); setError(null); setSaved(null); setJobId(null); setStopping(false); setStage({ stage: "saving_checked_copy" });
    try {
      const result = await skiptraceApply(dataset.id, config!, copyName.trim() || undefined, report.scan_job_id, watch("apply"));
      await turf.refresh(); setSaved(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(null); setActiveJob(null); setJobId(null); setStopping(false); }
  }
  async function stop() {
    if (!jobId) return;
    setStopping(true);
    try { await cancelSkiptraceJob(jobId); }
    catch (reason) { setError(String(reason)); setStopping(false); }
  }
  function showRows(filter: string, rowNumber?: number) {
    setReviewFilter(filter); setReviewRow(rowNumber); setReviewOpen(true);
    window.setTimeout(() => scrollInPane(document.getElementById(`review-${report?.scan_job_id}`)), 0);
  }
  const outcomes = report?.outcomes;
  const questionableColumns = base.phone_columns.filter(column => IDENTIFIER_COLUMN_NAME.test(column) && !PHONE_COLUMN_NAME.test(column));
  const hasPhones = base.phone_columns.length > 0 && missing.length === 0 && questionableColumns.every(column => confirmedIdentifierColumns.includes(column));
  const reachable = (index: number) => index === 0 || (index <= 2 ? hasPhones : Boolean(report));

  return (
    <section className="list-view skiptrace" ref={view}>
      <header className="list-head">
        <div>
          <h1>{dataset.name}</h1>
          <p>
            {formatNumber(setup.rows)} rows · {savedConfigKey === configKey ? "Setup saved with this list" : savedConfigKey ? "Setup edited since saving" : "Setup proposed from the columns"}
            {copy && <> · <button type="button" className="link" onClick={() => turf.open("lists", copy.id)}>Open the checked copy</button></>}
          </p>
        </div>
      </header>
      <p className="lede">Choose your phone columns, review any call evidence, then check the numbers. Your original list stays unchanged.</p>
      {error && <p className="notice" role="alert">{error}</p>}
      {draftError && <p className="notice" role="alert">{draftError}</p>}
      {!draftError && <p className="sr-only">Your draft is kept on this computer for this project and list, including when you switch lists or reload.</p>}
      {missing.length > 0 && <p className="notice" role="alert">This saved draft references missing columns: {missing.join(", ")}. <button type="button" className="button ghost" onClick={() => { setBase(setup.config); setOutcomeColumn(setup.outcome_column); setCalled(calledOf(setup)); setStatuses(setup.statuses); setMeaning(meaningOf(setup)); setReviewed(setup.statuses.filter(item => item.confirmed).map(item => item.key)); }}>Restore this list's suggested or saved setup</button></p>}
      {busy && <div className="notice" role="status" aria-live="polite"><span>{STAGE_LABELS[stage.stage] ?? stage.stage}{stage.total !== undefined && <> · {formatNumber(stage.completed ?? 0)} of {formatNumber(stage.total)} rows</>}{stopping && " · Stopping at the next safe checkpoint…"}</span>
        {stage.total !== undefined && <progress max={Math.max(1, stage.total)} value={stage.completed ?? 0} aria-label="Phone check progress" />}
        <button type="button" className="button ghost" disabled={!jobId || stopping} onClick={() => void stop()}>{stopping ? "Stopping…" : "Stop"}</button>
      </div>}

      {Object.keys(turf.legacyManual).length > 0 && !legacyImported && <div className="notice"><span>Earlier computer-wide marks are still stored separately. Import them into this project before checking if they belong here; existing project evidence and removals take precedence.</span><button type="button" className="button ghost" disabled={busy !== null || importingLegacy} onClick={async () => { setImportingLegacy(true); try { await turf.importLegacy(); setLegacyImported(true); } catch (reason) { setError(String(reason)); } finally { setImportingLegacy(false); } }}>Import earlier marks</button></div>}

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button type="button" disabled={!reachable(index) || busy !== null || statusBusy} aria-current={step === index ? "step" : undefined} onClick={() => setStep(index)}>
              <b>{index + 1}</b>{label}
            </button>
          </li>
        ))}
      </ol>
      {step !== 0 && questionableColumns.length > 0 && !hasPhones && <p className="notice" role="alert">Confirm the identifier-like phone field before continuing. <button type="button" className="link" onClick={() => setStep(0)}>Review column roles</button></p>}

      <fieldset className="workflow-inputs" hidden={step > 2} disabled={busy !== null || statusBusy || importingLegacy}>
      <legend className="sr-only">Phone-check setup</legend>
      <div className="wizard-step" hidden={step !== 0}>
      <article className="card step">
        <header><h2>Match your columns</h2></header>
        <p className="muted">Assign a role beside each field. You can choose several phone columns; names and locations help check who the numbers belong to.</p>
        <SkiptraceTemplates projectId={turf.projectId} columns={setup.columns} config={config} onApply={applyTemplate} onError={setError} />
        {questionableColumns.length > 0 && <div className="notice" role="alert"><span>Double-check {questionableColumns.join(", ")}: its name looks like an identifier, not a phone field. Choose another role if these are parcel or account numbers.</span><Check checked={questionableColumns.every(column => confirmedIdentifierColumns.includes(column))} onChange={on => setConfirmedIdentifierColumns(on ? questionableColumns : [])}>I verified these are phone numbers</Check></div>}
        {base.phone_columns.length === 0 && <p className="notice">Assign at least one field to Phone number to continue. The other roles provide context for the checks.</p>}
        <SkiptraceColumns columns={setup.columns} samples={setup.column_samples} config={base} onChange={mapColumns}
          countryControl={<Field label="Default phone country" value={base.region} searchable onChange={region => void changeRegion(region ?? "US")}
            options={REGIONS.map(code => ({ value: code, label: `${regionName(code)} (${code})` }))} />} />
      </article>
      </div>

      <div className="wizard-step" hidden={step !== 1}>
      <article className="card step">
        <header><h2>Use call results, if you have them</h2></header>
        <p className="muted">Map existing call results, or continue without call history.</p>
        <button type="button" className="link skiptrace-skip" disabled={!hasPhones || statusBusy || busy !== null || importingLegacy} onClick={async () => { await chooseOutcomeColumn(null); setStep(2); }}>Continue without call outcomes</button>
        <details className="step skiptrace-optional" onToggle={event => setDialerOpen(event.currentTarget.open)}><summary>Import or map a dialer export</summary>{dialerOpen && <DialerEvidence turf={turf} datasetId={dataset.id} />}</details>
        <div className="fields">
          <Field label="Status column" value={outcomeColumn} searchable optional="No outcome column" options={outcomeColumns.map(column => ({ value: column, label: column }))} onChange={column => void chooseOutcomeColumn(column)} />
          {outcomeColumn && base.phone_columns.length > 0 && (
            <Field label="The status describes the call to" value={called} options={base.phone_columns.map(column => ({ value: column, label: column }))} onChange={column => setCalled(column ?? "")} />
          )}
          <Field label="Call date column (optional)" value={base.call_date_column ?? null} searchable optional="Date unknown" options={columnOptions} onChange={call_date_column => patch({ call_date_column })} />
        </div>
        {statusBusy && <p role="status">Loading status meanings…</p>}
        {outcomeColumn && <details className="step skiptrace-optional"><summary>How call meanings and dates are used</summary><p className="muted">Known wrong numbers and disconnected lines apply across the project. Wrong person applies to the assigned owner of the called phone field and needs a mapped name. Reached means someone answered; it cannot also be a negative outcome. DNC can accompany either. Voicemail and no answer record activity only.</p><p className="muted">Dates inside statuses use {base.region === "US" ? "month/day/year" : "day/month/year"}; year-first dates stay unambiguous. DNC end dates are inclusive. Undated successful calls have an unknown age.</p></details>}
        {outcomeColumn && statuses.length > 0 && <>
          <p className="muted">{statuses.length - unreviewed.length} of {statuses.length} statuses reviewed · {ignored.length} ignored · {unreviewed.length} unreviewed. Unreviewed suggestions are included when checking.</p>
          <div className="row"><SearchBox value={statusQuery} onChange={value => { setStatusQuery(value); setStatusPageIndex(0); }} placeholder="Search call statuses" />
            <Check checked={unreviewedOnly} onChange={on => { setUnreviewedOnly(on); setStatusPageIndex(0); }}>Only unreviewed</Check>
            <button type="button" className="button ghost small" onClick={() => setReviewed([...new Set([...reviewed, ...statusView.rows.map(item => item.key)])])}>Confirm meanings on this page</button>
          </div>
        </>}
        {outcomeColumn && statuses.length > 0 && (
          <div className="table-wrap status-mapping-table">
            <table className="compact">
              <caption className="sr-only">What each status means</caption>
              <thead>
                <tr><th scope="col">Status / rows</th><th scope="col">Meaning</th><th scope="col">Review</th></tr>
              </thead>
              <tbody>
                {statusView.rows.map(status => (
                  <tr key={status.key}>
                    <th scope="row">{status.example}<small className="status-row-count muted">{formatNumber(status.count)} rows</small></th>
                    <td><details className="status-meanings"><summary aria-label={`Edit meanings for ${status.example}`}>{setup.outcomes.filter(outcome => (meaning[status.key] ?? []).includes(outcome.id)).map(outcome => outcome.label).join(" · ") || "No outcome"}<span className="muted">Edit</span></summary><div className="status-meaning-options">{setup.outcomes.map(outcome => (
                        <Check label={`${status.example}: ${outcome.label}`} checked={(meaning[status.key] ?? []).includes(outcome.id)}
                          key={outcome.id} onChange={on => { setMeaning({ ...meaning, [status.key]: toggled(meaning[status.key] ?? [], outcome.id, on) }); setReviewed([...new Set([...reviewed, status.key])]); }}>{outcome.label}</Check>
                    ))}</div></details></td>
                    <td><span className="muted">{reviewed.includes(status.key) ? meaning[status.key]?.length ? "Reviewed" : "Intentionally ignored" : "Suggested · unreviewed"}</span>
                      <div className="row"><button type="button" className="link" onClick={() => setReviewed([...new Set([...reviewed, status.key])])}>Confirm</button>
                      <button type="button" className="link" onClick={() => { setMeaning({ ...meaning, [status.key]: [] }); setReviewed([...new Set([...reviewed, status.key])]); }}>Ignore</button>
                      {reviewed.includes(status.key) && <button type="button" className="link" onClick={() => setReviewed(reviewed.filter(key => key !== status.key))}>Mark unreviewed</button>}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {outcomeColumn && statuses.length > 0 && <footer className="pager"><span>{statusView.total} matching statuses</span><div className="row">
          <button type="button" className="button ghost small" disabled={statusView.current === 0} onClick={() => setStatusPageIndex(statusView.current - 1)}>Previous</button><span>Page {statusView.current + 1} of {statusView.pages}</span>
          <button type="button" className="button ghost small" disabled={statusView.current + 1 >= statusView.pages} onClick={() => setStatusPageIndex(statusView.current + 1)}>Next</button>
        </div></footer>}
        {outcomeColumn && !statusBusy && statuses.length === 0 && <p className="muted">This status column has no nonempty values. You can continue without call outcomes.</p>}
        {outcomeColumn && <div className="row"><button type="button" className="button ghost" disabled={busy !== null || statusBusy || missing.length > 0 || !hasPhones} onClick={async () => {
          setStatusBusy(true); setError(null); setMappingMessage(null);
          try { await skiptraceSave(dataset.id, config); await turf.refresh(); setSavedConfigKey(configKey); setMappingMessage("Dialer mappings saved. Return to your lead list and check phones to use these results."); }
          catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
          finally { setStatusBusy(false); }
        }}>Save outcome mappings</button>{mappingMessage && <span role="status">{mappingMessage}</span>}</div>}
      </article>
      </div>

      <div className="wizard-step" hidden={step !== 2}>
      <article className="card step">
        <header><h2>Warning signs</h2></header>
        <p className="muted">Choose what should flag a number for review. A warning sign does not prove the number is wrong.</p>
        <div className="checks column">
          {setup.signals.filter(sign => !sign.measured_only).map(sign => (
            <Check key={sign.code} checked={Boolean(base.signals[sign.code])} onChange={on => patch({ signals: { ...base.signals, [sign.code]: on } })}><span>{sign.label}</span><small>{SIGN_HELP[sign.code]?.needs}
              {sign.code === "shared_number" && ![base, ...(base.additional_owners ?? [])].some(owner => owner.name_column || owner.first_name_column || owner.last_name_column) && <><br />No owner name column mapped yet.</>}
              {sign.code === "area_code_other_state" && !base.state_column && <><br />No property state column mapped yet.</>}
              {sign.code === "country_mismatch" && !base.country_column && !base.zip_column && !base.state_column && <><br />No address country evidence mapped yet.</>}
            </small></Check>
          ))}
        </div>
        <details className="step skiptrace-optional"><summary>Warning-sign examples</summary><dl className="signal-examples">{setup.signals.filter(sign => !sign.measured_only).map(sign => <div key={sign.code}><dt>{sign.label}</dt><dd>{SIGN_HELP[sign.code]?.example}</dd></div>)}</dl></details>
        <details className="step skiptrace-optional"><summary>Evidence age settings</summary><div className="fields"><label className="field"><span>Review successful-call evidence after this many days</span><input className="input" type="number" min="1" max="3650" value={base.evidence_age_days ?? 180} onChange={event => patch({ evidence_age_days: Number(event.target.value) })} /></label><label className="field"><span>Flag live lookup results after this many days</span><input className="input" type="number" min="1" max="365" value={base.lookup_age_days ?? 30} onChange={event => patch({ lookup_age_days: Number(event.target.value) })} /></label></div><p className="muted">Aging evidence prompts review; it does not prove reassignment.</p></details>
        {config && <details className="step skiptrace-optional" onToggle={event => setAdvancedLookup(event.currentTarget.open)}><summary>Optional external lookup</summary><p className="muted">Dialer exports and normal phone checks work without an external provider.</p>{advancedLookup && <PhoneLookup datasetId={dataset.id} config={config} projectId={turf.projectId} onUpdated={turf.refresh} />}</details>}
        <div className="skiptrace-check-summary"><span>{base.phone_columns.length} phone {base.phone_columns.length === 1 ? "column" : "columns"}</span><span>{1 + (base.additional_owners?.length ?? 0)} owner {(base.additional_owners?.length ?? 0) === 0 ? "group" : "groups"}</span><span>{outcomeColumn ? `${statuses.length - unreviewed.length}/${statuses.length} call statuses reviewed` : "No call outcomes"}</span></div>
        <details className="step skiptrace-optional"><summary>Review before checking</summary>
        <dl className="skiptrace-review-summary"><div><dt>Phone columns</dt><dd>{base.phone_columns.join(", ")}</dd></div><div><dt>Country</dt><dd>{regionName(base.region)} · row override: {base.country_column ?? "None"}</dd></div>
          <div><dt>Owners and mailing fields</dt><dd>{[base, ...(base.additional_owners ?? [])].map((owner, index) => `Owner ${index + 1}: ${[owner.first_name_column, owner.last_name_column, owner.name_column, owner.mailing_address_column, owner.mailing_city_column, owner.mailing_state_column, owner.mailing_zip_column, owner.owner_type_column].filter(Boolean).join(", ") || "Not mapped"}`).join(" · ")}</dd></div>
          <div><dt>Phone owner assignments</dt><dd>{base.phone_columns.map(column => `${column}: ${base.phone_owner_map?.[column] === -1 || (base.additional_owners?.length && base.phone_owner_map?.[column] === undefined) ? "Owner unknown" : `Owner ${(base.phone_owner_map?.[column] ?? 0) + 1}`}`).join(" · ")}</dd></div>
          <div><dt>Property and vacancy fields</dt><dd>{[base.address_column, base.city_column, base.zip_column, base.state_column, base.vacancy_column].filter(Boolean).join(", ") || "Not mapped"}</dd></div>
          <div><dt>Outcomes</dt><dd>{outcomeColumn ? `${outcomeColumn} describes ${called}; ${unreviewed.length} unreviewed statuses; ${ignored.length} intentionally ignored` : "No outcome column"}</dd></div>
          <div><dt>Warning signs</dt><dd>{setup.signals.filter(sign => !sign.measured_only && base.signals[sign.code]).map(sign => sign.label).join(" · ") || "All configurable signs off"}</dd></div>
        </dl>
        </details>
        <div className="row"><button type="button" className="link" onClick={() => setStep(0)}>Edit columns</button><button type="button" className="link" onClick={() => setStep(1)}>Review call outcomes</button></div>
      </article>
      </div>

      </fieldset>

      {report && outcomes && (
        <>
          <div className="wizard-step" hidden={step !== 3}>
          {freshnessError && <p className="notice" role="alert">Cannot verify this check: {freshnessError}. Saving stays unavailable until freshness is verified.</p>}
          {stale && (
            <p className="notice" role="status">
              <span>{staleSetup ? "You changed the setup after this check." : "The date or project evidence changed after this check."} These results are out of date; check again before saving.</span>
              <button type="button" className="button" disabled={busy !== null || !hasPhones} onClick={() => void check()}>{busy === "scan" ? "Checking…" : "Check again"}</button>
            </p>
          )}

          <article className="card step">
            <header><h2>What needs attention?</h2><span className="count">Checked {new Date(report.checked_at).toLocaleString()}</span></header>

            <div className="action-summary">{[
              ["callable", "Rows with a usable number"], ["known_wrong", "Rows containing known wrong numbers"], ["dnc", "Rows containing do-not-call numbers"], ["needs_review", "Rows needing review"], ["no_phone", "Rows with no phone values"],
            ].map(([filter, label]) => <button type="button" className="summary-item" key={filter} onClick={() => showRows(filter)}><strong>{formatNumber(report.row_counts[filter] ?? 0)}</strong><span>{label}</span><small>Review rows →</small></button>)}</div>
            <details className="step skiptrace-optional"><summary>How to read this check</summary>
            <p className="muted">These are row counts; categories can overlap. A row with a blocked phone can still have another usable number. Usable includes suspicious and unverified numbers: it does not prove ownership or connection. Review blocked numbers without deleting the row.</p>
            <p className="muted">Cross-file evidence: {report.other_datasets_used.join(", ") || "No other saved lists"}. Manual marks: {Object.keys(report.manual_evidence).length} in this project at check time. Sign-performance measurements use mapped call outcomes.</p>
            </details>

            <button type="button" className="button ghost" onClick={() => showRows("all")}>Review all checked rows</button>
          </article>
          {reviewOpen && <SkiptraceReview report={report} filter={reviewFilter} rowNumber={reviewRow} datasetId={dataset.id} onUpdated={turf.refresh} onFilter={filter => { setReviewFilter(filter); setReviewRow(undefined); }} />}
          {report.phone_assessments && <ReportSection id={`quality-${dataset.id}`} title="Phone quality and calling restrictions"><dl className="metrics">{(["corroborated", "unverified", "suspicious", "wrong"] as const).map(quality => <div key={quality}><dt>Quality: {quality}</dt><dd>{formatNumber(report.phone_assessments?.[quality] ?? 0)}</dd></div>)}<div><dt>Active DNC blocks</dt><dd>{formatNumber(report.phone_assessments.blocked_dnc ?? 0)}</dd></div><div><dt>Aging or review warnings</dt><dd>{formatNumber(report.phone_assessments.needs_review ?? 0)}</dd></div></dl><p className="muted">Counts are per-row phone choices. Quality and calling restrictions are separate; a valid number can still be blocked by DNC.</p></ReportSection>}
          <ReportSection id={`verdicts-${dataset.id}`} title="Results" count={`${formatNumber(report.values)} phone values`}>

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

          <ReportSection id={`columns-${dataset.id}`} title="Which phone columns are worth using">

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
            <ReportSection id={`reasons-${dataset.id}`} title="Why numbers got their verdict">

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
            <ReportSection id={`signals-${dataset.id}`} title="Do the warning signs predict wrong numbers here?">

              <p className="muted">
                Measured on the {formatNumber(outcomes.contacted)} rows where a call either reached a person or found a wrong number. In this data, {percent(outcomes.baseline_wrong_rate, 1)} of those calls were a wrong number.
                A sign is only useful if it is clearly above that.
              </p>
              {report.signals.some(sign => !sign.measured_only && sign.enough_data) && (
                <div className="row">
                  <button type="button" className="button ghost" disabled={busy !== null || stale || freshnessPending} onClick={() => { setPreviousSignals(base.signals); patch({ signals: { ...base.signals, ...Object.fromEntries(report.signals.filter(sign => !sign.measured_only && sign.enough_data).map(sign => [sign.code, sign.predictive])) } }); }}>
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

          {previousSignals && <p className="notice" role="status"><span>Predictive signs were applied. Review them in Warning signs and check again.</span><button type="button" className="button ghost" disabled={busy !== null} onClick={() => { patch({ signals: previousSignals }); setPreviousSignals(null); }}>Undo sign changes</button></p>}
          <ReportSection id={`phone-details-${dataset.id}`} title="What was found in the numbers">

            <dl className="metrics text">
              <div><dt>Kinds of line</dt><dd>{Object.entries(report.types).map(([name, count]) => `${name}: ${formatNumber(count)}`).join(" · ") || "No valid numbers"}</dd></div>
              <div><dt>Countries</dt><dd>{Object.entries(report.countries).map(([code, count]) => `${regionName(code)}: ${formatNumber(count)}`).join(" · ") || "None"}</dd></div>
              {report.repairs.length > 0 && <div><dt>Repaired while reading</dt><dd>{report.repairs.map(repair => `${repair.note}: ${formatNumber(repair.count)}`).join(" · ")}</dd></div>}
            </dl>
            <p className="muted">In the US a landline cannot be told from a mobile, so most come back as “landline or mobile”. The rules check that a number follows its country&apos;s plan, not that it is in service.</p>
          </ReportSection>

          </div>

          <div className="wizard-step" hidden={step !== 4}>
          <article className="card step">
            <header><h2>Save the checked copy</h2></header>
            <p className="muted">This saves the exact reviewed results as a new list.</p>
            <dl className="metrics"><div><dt>Source rows</dt><dd>{formatNumber(report.rows)}</dd></div><div><dt>Added result columns</dt><dd>{report.added_columns.length}</dd></div><div><dt>Checked</dt><dd className="save-check-date">{new Date(report.checked_at).toLocaleString()}</dd></div></dl>
            {stale && <p className="notice" role="status">The setup, date, or evidence changed. <button type="button" className="button" disabled={busy !== null || !hasPhones} onClick={() => void check()}>Check again</button></p>}
            {freshnessError && <p role="alert" className="notice">{freshnessError}</p>}
            <label className="field save-copy-name">
              <span>Name of the checked copy</span>
              <input className="input" value={copyName} disabled={busy !== null} placeholder={`${dataset.name} (phones checked)`} onChange={event => setCopyName(event.target.value)} />
            </label>
            {freshnessPending && <p className="muted" role="status">Verifying the check before saving…</p>}
            <details className="step skiptrace-optional"><summary>Preview the checked copy</summary><CheckedPreview report={report} /></details>
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
      <ManualEvidence turf={turf} />
      </div>

      <div className="wizard-step" hidden={step !== 4}>
      <details className="card step"><summary>Downloads and original file</summary><p className="muted">Your original file stays in this project. Each saved checked copy keeps all rows and result columns for download later.</p><ListDownloads datasetId={dataset.id} fail={turf.fail} /></details>
      {copies.length > 0 && <details className="card step"><summary>Checked-copy history ({copies.length})</summary><p className="muted">The newest copy is used when you open the original in Lists. Every previous copy remains available.</p>
        <ul className="copy-history">{copies.map((item, index) => <li key={item.id}><button type="button" className="link" onClick={() => turf.open("lists", item.id)}>{item.name}</button><span>{index === 0 ? "Latest · " : ""}{new Date(item.created_at).toLocaleString()} · {formatNumber(item.row_count)} rows</span><ListDownloads datasetId={item.id} checkedId={item.id} fail={turf.fail} /></li>)}</ul>
      </details>}
      </div>

      <footer className="wizard-nav">
        <button type="button" className="button ghost" disabled={step === 0 || busy !== null || statusBusy} onClick={() => setStep(step - 1)}>Back</button>
        <span className="muted">Step {step + 1} of {STEPS.length}: {STEPS[step]}</span>
        {step < 2 && <button type="button" className="button" disabled={!hasPhones || busy !== null || statusBusy || importingLegacy} onClick={() => setStep(step + 1)}>Next</button>}
        {step === 2 && !hasPhones && <button type="button" className="button" onClick={() => setStep(0)}>Review column roles</button>}
        {step === 2 && hasPhones && (
          <div className="row">
            {report && !stale && <button type="button" className="button ghost" onClick={() => setStep(3)}>See the last results</button>}
            <button type="button" className="button" disabled={!hasPhones || busy !== null || statusBusy || importingLegacy} onClick={() => void check()}>
              {busy === "scan" ? "Checking…" : report ? "Check again" : "Check phone numbers"}
            </button>
          </div>
        )}
        {step === 3 && (!hasPhones ? <button type="button" className="button" onClick={() => setStep(0)}>Review column roles</button> : <button type="button" className="button" disabled={stale || busy !== null || freshnessPending} onClick={() => setStep(4)}>Next</button>)}
        {step === 4 && report && <button type="button" className="button" disabled={busy !== null || stale || freshnessPending || !hasPhones} onClick={() => void saveCopy()}>{busy === "apply" ? "Saving…" : "Save checked copy"}</button>}
      </footer>
    </section>
  );
}
