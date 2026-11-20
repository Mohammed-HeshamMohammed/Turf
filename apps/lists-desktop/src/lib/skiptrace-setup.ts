import { useEffect, useMemo, useRef, useState } from "react";
import type { CallerWhale } from "../App";
import {
  cancelSkiptraceJob,
  knownSuggestion,
  skiptraceApply,
  skiptraceFreshness,
  skiptraceModelStatus,
  skiptraceRemember,
  skiptraceSave,
  skiptraceScan,
  skiptraceStatuses,
  skiptraceSuggest,
  watchJob,
} from "./service";
import {
  buildConfig,
  checkedCopies,
  missingColumns,
  namesMapped,
  readDraft,
  refreshReadings,
  sameOutcomes,
  settledKeys,
  signEvidence,
  signReadiness,
  stableKey,
  type WorkflowDraft,
} from "./skiptrace-workflow";
import type { Dataset, Outcome, SkiptraceConfig, SkiptraceReport, SkiptraceSuggestion, StatusModelState, StatusRow } from "./types";

// The state and the actions behind Skip Tracing's five steps for one list. The steps themselves only draw
// (src/components/SkiptraceStep*.tsx); what they share lives here: the setup being edited, the call statuses and what
// they mean, the running check, its report, and the draft kept on this computer.

export const STEPS = ["Column roles", "Call outcomes", "Warning signs", "Results", "Save the copy"];

const PHONE_COLUMN_NAME = /phone|mobile|cell|tel(?!l)|fax|whatsapp|contact number|landline|gsm|celular|m[oó]vil|portable|handy|هاتف|موبايل|جوال|تليفون|محمول/i;
const IDENTIFIER_COLUMN_NAME = /\b(?:id|identifier|apn|parcel|account|property|mls|tax|zip|postal|ssn)\b/i;

export type SavedCopy = { dataset_id: string; rows: number; added_columns: string[] };
export type JobStage = { stage: string; completed?: number; total?: number };

/** Scrolls something to the top of the pane it is in, without moving anything else. */
export function scrollInPane(target: HTMLElement | null | undefined) {
  const pane = target?.closest<HTMLElement>(".scroller");
  if (pane && target) pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
}

const calledOf = (suggestion: SkiptraceSuggestion) => suggestion.config.outcome?.called_column ?? suggestion.config.phone_columns[0] ?? "";
const meaningOf = (suggestion: SkiptraceSuggestion) => Object.fromEntries(suggestion.statuses.map(status => [status.key, status.outcomes]));
const confirmedOf = (suggestion: SkiptraceSuggestion) => suggestion.statuses.filter(item => item.confirmed).map(item => item.key);
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const stageOf = (event: Record<string, unknown>): JobStage | null =>
  typeof event.stage === "string"
    ? {
        stage: event.stage,
        completed: typeof event.completed === "number" ? event.completed : undefined,
        total: typeof event.total === "number" ? event.total : undefined,
      }
    : null;

export function useSkiptraceSetup(callerwhale: CallerWhale, dataset: Dataset) {
  const draftKey = `callerwhale.skiptrace.draft.${callerwhale.projectId}.${dataset.id}`;
  const [draft] = useState(() => readDraft(draftKey));
  const [known] = useState(() => knownSuggestion(dataset.id));

  // The setup: the columns and their roles, the status column and what each status means.
  const [setup, setSetup] = useState<SkiptraceSuggestion | null>(known);
  const [base, setBase] = useState<SkiptraceConfig | null>(draft?.base ?? known?.config ?? null);
  const [outcomeColumn, setOutcomeColumn] = useState<string | null>(draft ? draft.outcomeColumn : (known?.outcome_column ?? null));
  const [called, setCalled] = useState(draft?.called ?? (known ? calledOf(known) : ""));
  const [statuses, setStatuses] = useState<StatusRow[]>(known?.statuses ?? []);
  const [meaning, setMeaning] = useState<Record<string, Outcome[]>>(draft?.meaning ?? (known ? meaningOf(known) : {}));
  const [reviewed, setReviewed] = useState<string[]>(draft?.reviewed ?? (known ? confirmedOf(known) : []));
  const [confirmedIdentifierColumns, setConfirmedIdentifierColumns] = useState<string[]>([]);
  const [statusBusy, setStatusBusy] = useState(false);
  const statusRequest = useRef(0);
  const [statusPageIndex, setStatusPageIndex] = useState(0);
  const [modelState, setModelState] = useState<StatusModelState | undefined>(known?.status_model);
  const [savedConfigKey, setSavedConfigKey] = useState<string | null>(known?.saved ? stableKey(known.config) : null);
  const [previousSignals, setPreviousSignals] = useState<Record<string, boolean> | null>(null);

  // Where the person is, and the check: the job running now, its report, and the copy saved from it.
  const [step, setStep] = useState(Math.min(4, Math.max(0, draft?.step ?? 0)));
  const [busy, setBusy] = useState<"scan" | "apply" | null>(draft?.activeJob?.kind ?? null);
  const [activeJob, setActiveJob] = useState<WorkflowDraft["activeJob"]>(draft?.activeJob ?? null);
  const [jobId, setJobId] = useState<string | null>(draft?.activeJob?.id ?? null);
  const [stage, setStage] = useState<JobStage>({ stage: draft?.activeJob ? "recovering" : "saving_setup" });
  const [stopping, setStopping] = useState(false);
  const [report, setReport] = useState<SkiptraceReport | null>(draft?.report ?? null);
  const [scannedWith, setScannedWith] = useState<string | null>(draft?.scannedWith ?? null);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [copyName, setCopyName] = useState(draft?.copyName ?? "");
  const [saved, setSaved] = useState<SavedCopy | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [freshnessError, setFreshnessError] = useState<string | null>(null);
  const [importingLegacy, setImportingLegacy] = useState(false);
  const [legacyImported, setLegacyImported] = useState(false);

  const copies = checkedCopies(callerwhale.datasets, dataset.id);
  const copy = copies[0] ?? null;

  useEffect(() => {
    let current = true;
    async function load() {
      try {
        const result = known ?? (await skiptraceSuggest(dataset.id));
        if (!current) return;
        setSetup(result);
        setModelState(result.status_model);
        if (result.saved) setSavedConfigKey(stableKey(result.config));
        if (!draft) {
          setBase(result.config);
          setOutcomeColumn(result.outcome_column);
          setCalled(calledOf(result));
          setStatuses(result.statuses);
          setMeaning(meaningOf(result));
          setReviewed(confirmedOf(result));
        } else if (draft.outcomeColumn && result.columns.includes(draft.outcomeColumn)) {
          setStatusBusy(true);
          const table = await skiptraceStatuses(dataset.id, draft.outcomeColumn, draft.base.region, namesMapped(draft.base, draft.called));
          if (!current) return;
          setStatuses(table);
          if (draft.readings === 2) {
            setMeaning(Object.fromEntries(table.map(item => [item.key, draft.meaning[item.key] ?? item.outcomes])));
            setReviewed([...new Set([...draft.reviewed, ...settledKeys(table, draft.meaning)])]);
          } else {
            // A draft from the earlier version: its plain suggestions give way to today's readings; the person's own
            // changes stay, and the ones they confirmed are remembered for the project.
            const earlier = table.map(item => ({ ...item, outcomes: item.earlier ?? [], confirmed: true }));
            const next = refreshReadings(earlier, table, draft.meaning, draft.reviewed);
            setMeaning(Object.fromEntries(table.map(item => [item.key, next.meaning[item.key] ?? item.outcomes])));
            setReviewed(next.reviewed);
            const chosen = table.filter(
              item => item.key && draft.reviewed.includes(item.key) && draft.meaning[item.key] && !sameOutcomes(draft.meaning[item.key], item.earlier ?? []),
            );
            if (chosen.length)
              void skiptraceRemember(dataset.id, Object.fromEntries(chosen.map(item => [item.key, draft.meaning[item.key]]))).catch(() => undefined);
          }
        } else setStatuses([]);
      } catch (reason) {
        if (current) setError(message(reason));
      } finally {
        if (current) setStatusBusy(false);
      }
    }
    void load();
    return () => {
      current = false;
      statusRequest.current += 1;
    };
  }, [dataset.id, known, draft]);

  const config = useMemo(() => (base ? buildConfig(base, outcomeColumn, called, meaning, reviewed) : null), [base, outcomeColumn, called, meaning, reviewed]);
  const configKey = stableKey(config);
  const staleSetup = Boolean(report) && scannedWith !== configKey;
  const staleEvidence = Boolean(report && fingerprint && report.fingerprint !== fingerprint);
  const stale = staleSetup || staleEvidence;
  const freshnessPending = Boolean(report) && !fingerprint;

  // Whether the report still matches the project: asked when it arrives, every half minute, and when the window is back.
  const hasReport = Boolean(report);
  const reportFingerprint = report?.fingerprint;
  useEffect(() => {
    if (!hasReport) return;
    let current = true;
    setFingerprint(null);
    const check = () =>
      skiptraceFreshness(dataset.id).then(
        value => {
          if (current) {
            setFingerprint(value.fingerprint);
            setFreshnessError(null);
          }
        },
        reason => {
          if (current) {
            setFingerprint(null);
            setFreshnessError(String(reason));
          }
        },
      );
    void check();
    const interval = window.setInterval(() => void check(), 30_000);
    const focus = () => void check();
    window.addEventListener("focus", focus);
    return () => {
      current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [hasReport, reportFingerprint, dataset.id, callerwhale.version, callerwhale.manual]);

  // A check or a save that was running when the screen was reloaded is followed again.
  const refreshLists = useRef(callerwhale.refresh);
  refreshLists.current = callerwhale.refresh;
  useEffect(() => {
    if (!draft?.activeJob) return;
    const active = draft.activeJob;
    let current = true;
    const watch = {
      onEvent: (event: Record<string, unknown>) => {
        const next = stageOf(event);
        if (current && next) setStage(next);
      },
    };
    async function resume() {
      try {
        if (active.kind === "scan") {
          const result = await watchJob<{ report: SkiptraceReport }>(active.id, watch);
          if (current) {
            setReport(result.report);
            setScannedWith(active.configKey);
            setFingerprint(result.report.fingerprint);
            setStep(3);
          }
        } else {
          const result = await watchJob<SavedCopy>(active.id, watch);
          if (current) {
            await refreshLists.current();
            setSaved(result);
            setStep(4);
          }
        }
      } catch (reason) {
        if (current) setError(String(reason));
      } finally {
        if (current) {
          setBusy(null);
          setActiveJob(null);
          setJobId(null);
        }
      }
    }
    void resume();
    return () => {
      current = false;
    };
  }, [draft]);

  // The draft: kept on this computer for this project and list.
  useEffect(() => {
    if (!setup || !base || statusBusy) return;
    const state: WorkflowDraft = { base, outcomeColumn, called, meaning, reviewed, step, copyName, report, scannedWith, activeJob, readings: 2 };
    try {
      localStorage.setItem(draftKey, JSON.stringify({ version: 1, state }));
      setDraftError(null);
    } catch {
      setDraftError("Your draft could not be saved on this computer. Keep this tab open; storage may be full or unavailable.");
    }
  }, [setup, base, outcomeColumn, called, meaning, reviewed, step, copyName, report, scannedWith, draftKey, statusBusy, activeJob]);

  // While the status model is being fetched, ask now and then; once it is ready the statuses are read again with it.
  useEffect(() => {
    if (modelState !== "downloading") return;
    let current = true;
    const timer = window.setInterval(async () => {
      try {
        const next = (await skiptraceModelStatus()).state;
        if (!current || next === "downloading") return;
        if (next === "ready" && outcomeColumn && base) {
          const table = await skiptraceStatuses(dataset.id, outcomeColumn, base.region, namesMapped(base, called));
          if (!current) return;
          const refreshed = refreshReadings(statuses, table, meaning, reviewed);
          setStatuses(table);
          setMeaning(refreshed.meaning);
          setReviewed(refreshed.reviewed);
        }
        setModelState(next); // last: it ends this polling
      } catch {
        /* the next tick tries again */
      }
    }, 2000);
    return () => {
      current = false;
      window.clearInterval(timer);
    };
  }, [modelState, outcomeColumn, base, called, statuses, meaning, reviewed, dataset.id]);

  const outcomeColumns = useMemo(() => {
    if (!setup) return [];
    const preferred = setup.outcome_candidates.map(item => item.column);
    return [...preferred, ...setup.columns.filter(column => !preferred.includes(column))];
  }, [setup]);
  const unreviewed = statuses.filter(item => !reviewed.includes(item.key));
  // Ignored by the person: a status Caller Whale settled as "not called yet" is not counted.
  const ignored = statuses.filter(item => reviewed.includes(item.key) && !meaning[item.key]?.length && !(item.sure && !item.outcomes.length));
  const signs = setup?.signals.filter(sign => !sign.measured_only) ?? [];
  // Signs the last check measured with enough calls, whose switch disagrees with what they showed.
  const advice =
    base && report?.outcomes.available
      ? signs.flatMap(sign => {
          const evidence = signEvidence(
            report.signals.find(item => item.code === sign.code),
            true,
          );
          return evidence.on !== undefined && evidence.on !== Boolean(base.signals[sign.code]) && signReadiness(sign.code, base).ready
            ? [{ code: sign.code, label: sign.label, on: evidence.on }]
            : [];
        })
      : [];
  const settledBefore = statuses.filter(item => reviewed.includes(item.key) && (item.source === "memory" || item.source === "saved") && item.sure).length;
  const automatic = statuses.filter(item => reviewed.includes(item.key) && item.sure && item.source !== "memory" && item.source !== "saved").length;
  const missing = setup && config ? missingColumns(config, setup.columns) : [];
  const questionableColumns = (base?.phone_columns ?? []).filter(column => IDENTIFIER_COLUMN_NAME.test(column) && !PHONE_COLUMN_NAME.test(column));
  const hasPhones =
    Boolean(base?.phone_columns.length) && missing.length === 0 && questionableColumns.every(column => confirmedIdentifierColumns.includes(column));

  // What the person decides is kept for every list in the project, so the same wording is settled next time.
  const decide = (decisions: Record<string, Outcome[] | null>) => {
    const kept = Object.fromEntries(Object.entries(decisions).filter(([key]) => key));
    if (Object.keys(kept).length)
      skiptraceRemember(dataset.id, kept).catch(reason => setError(`Your choice is used here but could not be remembered for other lists: ${message(reason)}`));
  };
  const confirmStatus = (key: string, outcomes: Outcome[]) => {
    setReviewed([...new Set([...reviewed, key])]);
    decide({ [key]: outcomes });
  };
  const patch = (changes: Partial<SkiptraceConfig>) => {
    if (base) setBase({ ...base, ...changes });
  };
  const mapColumns = (next: SkiptraceConfig) => {
    setConfirmedIdentifierColumns(current => current.filter(column => next.phone_columns.includes(column)));
    setBase(next);
    if (!next.phone_columns.includes(called)) setCalled(next.phone_columns[0] ?? "");
  };
  /** Back to what the list itself suggests or has saved, when a draft names columns the list no longer has. */
  const restore = () => {
    if (!setup) return;
    setBase(setup.config);
    setOutcomeColumn(setup.outcome_column);
    setCalled(calledOf(setup));
    setStatuses(setup.statuses);
    setMeaning(meaningOf(setup));
    setReviewed(confirmedOf(setup));
  };

  async function chooseOutcomeColumn(column: string | null, region = base!.region) {
    const request = ++statusRequest.current;
    setStatusBusy(true);
    setError(null);
    try {
      const table = column ? await skiptraceStatuses(dataset.id, column, region, namesMapped(base!, called)) : [];
      if (request !== statusRequest.current) return;
      setOutcomeColumn(column);
      setStatuses(table);
      setMeaning(Object.fromEntries(table.map(status => [status.key, status.outcomes])));
      setReviewed(settledKeys(table));
      setStatusPageIndex(0);
    } catch (reason) {
      if (request === statusRequest.current) setError(message(reason));
    } finally {
      if (request === statusRequest.current) setStatusBusy(false);
    }
  }
  async function changeRegion(region: string) {
    if (!base || region === base.region) return;
    // Changing date interpretation must not retain status keys from another country's format.
    if (outcomeColumn) {
      setStatusBusy(true);
      try {
        const table = await skiptraceStatuses(dataset.id, outcomeColumn, region, namesMapped(base, called));
        setBase({ ...base, region });
        setStatuses(table);
        setMeaning(Object.fromEntries(table.map(status => [status.key, meaning[status.key] ?? status.outcomes])));
        setReviewed([...new Set([...reviewed.filter(key => table.some(item => item.key === key)), ...settledKeys(table, meaning)])]);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setStatusBusy(false);
      }
    } else patch({ region });
  }
  async function applyTemplate(next: SkiptraceConfig) {
    setStatusBusy(true);
    try {
      const column = next.outcome?.column ?? null;
      const nextCalled = next.outcome?.called_column ?? next.phone_columns[0] ?? "";
      const table = column ? await skiptraceStatuses(dataset.id, column, next.region, namesMapped(next, nextCalled)) : [];
      setBase(next);
      setOutcomeColumn(column);
      setCalled(nextCalled);
      setStatuses(table);
      setMeaning(Object.fromEntries(table.map(item => [item.key, next.outcome?.map[item.key] ?? item.outcomes])));
      setReviewed(settledKeys(table, next.outcome?.map));
      setStep(0);
      setStatusPageIndex(0);
    } finally {
      setStatusBusy(false);
    }
  }
  /** Saves the setup as it is, so a dialer export's mappings are used by the checks of other lists. */
  async function saveMappings(): Promise<boolean> {
    if (!config) return false;
    setStatusBusy(true);
    setError(null);
    try {
      await skiptraceSave(dataset.id, config);
      await callerwhale.refresh();
      setSavedConfigKey(configKey);
      return true;
    } catch (reason) {
      setError(message(reason));
      return false;
    } finally {
      setStatusBusy(false);
    }
  }
  const watch = (kind: "scan" | "apply") => ({
    onStart: (id: string) => {
      setJobId(id);
      const active = { id, kind, configKey };
      setActiveJob(active);
      try {
        const current = readDraft(draftKey);
        if (current) localStorage.setItem(draftKey, JSON.stringify({ version: 1, state: { ...current, activeJob: active } }));
      } catch {
        setDraftError("The running job could not be saved for recovery. Keep this tab open.");
      }
    },
    onEvent: (event: Record<string, unknown>) => {
      const next = stageOf(event);
      if (next) setStage(next);
    },
  });
  const begin = (kind: "scan" | "apply", first: string) => {
    setBusy(kind);
    setError(null);
    setSaved(null);
    setJobId(null);
    setStopping(false);
    setStage({ stage: first });
  };
  const finish = () => {
    setBusy(null);
    setActiveJob(null);
    setJobId(null);
    setStopping(false);
  };
  async function check() {
    if (busy || statusBusy || importingLegacy || !hasPhones || !config) return;
    begin("scan", "saving_setup");
    try {
      await skiptraceSave(dataset.id, config);
      setSavedConfigKey(configKey);
      const result = await skiptraceScan(dataset.id, config, watch("scan"));
      setReport(result.report);
      setFingerprint(result.report.fingerprint);
      setScannedWith(configKey);
      setStep(3);
    } catch (reason) {
      setError(message(reason));
    } finally {
      finish();
    }
  }
  async function saveCopy() {
    if (busy || !report || stale || freshnessPending || !hasPhones || !config) return;
    begin("apply", "saving_checked_copy");
    try {
      const result = await skiptraceApply(dataset.id, config, copyName.trim() || undefined, report.scan_job_id, watch("apply"));
      await callerwhale.refresh();
      setSaved(result);
    } catch (reason) {
      setError(message(reason));
    } finally {
      finish();
    }
  }
  async function stop() {
    if (!jobId) return;
    setStopping(true);
    try {
      await cancelSkiptraceJob(jobId);
    } catch (reason) {
      setError(String(reason));
      setStopping(false);
    }
  }
  async function importLegacy() {
    setImportingLegacy(true);
    try {
      await callerwhale.importLegacy();
      setLegacyImported(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setImportingLegacy(false);
    }
  }
  /** Turns each warning sign on or off as the last check measured it; `undoSigns` puts back what was set before. */
  const applyMeasuredSigns = () => {
    if (!base || !report) return;
    setPreviousSignals(base.signals);
    patch({
      signals: {
        ...base.signals,
        ...Object.fromEntries(report.signals.filter(sign => !sign.measured_only && sign.enough_data).map(sign => [sign.code, sign.predictive])),
      },
    });
  };
  const undoSigns = previousSignals
    ? () => {
        patch({ signals: previousSignals });
        setPreviousSignals(null);
      }
    : null;

  return {
    callerwhale,
    dataset,
    // the setup
    setup,
    base,
    config,
    configKey,
    savedConfigKey,
    outcomeColumn,
    outcomeColumns,
    called,
    setCalled,
    statuses,
    meaning,
    setMeaning,
    reviewed,
    setReviewed,
    statusBusy,
    statusPageIndex,
    setStatusPageIndex,
    modelState,
    unreviewed,
    ignored,
    settledBefore,
    automatic,
    signs,
    advice,
    missing,
    questionableColumns,
    confirmedIdentifierColumns,
    setConfirmedIdentifierColumns,
    hasPhones,
    // the check
    step,
    setStep,
    busy,
    jobId,
    stage,
    stopping,
    report,
    stale,
    staleSetup,
    freshnessPending,
    freshnessError,
    copyName,
    setCopyName,
    saved,
    copies,
    copy,
    error,
    setError,
    draftError,
    importingLegacy,
    legacyImported,
    // what the person can do
    decide,
    confirmStatus,
    patch,
    mapColumns,
    restore,
    chooseOutcomeColumn,
    changeRegion,
    applyTemplate,
    saveMappings,
    check,
    saveCopy,
    stop,
    importLegacy,
    applyMeasuredSigns,
    undoSigns,
  };
}

export type SkiptraceSetup = ReturnType<typeof useSkiptraceSetup>;
/** The setup once it has been read: the steps are only drawn then. */
export type ReadySetup = SkiptraceSetup & { setup: SkiptraceSuggestion; base: SkiptraceConfig; config: SkiptraceConfig };
