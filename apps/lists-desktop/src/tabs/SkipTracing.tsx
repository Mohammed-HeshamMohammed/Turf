import { useEffect, useRef, useState } from "react";
import type { CallerWhale } from "../App";
import { Empty } from "../components/Bits";
import { copyText } from "../components/ContextMenu";
import { ListPicker } from "../components/ListPicker";
import { ManualEvidence } from "../components/ManualEvidence";
import { SkiptraceStepOutcomes } from "../components/SkiptraceStepOutcomes";
import { SkiptraceStepResults } from "../components/SkiptraceStepResults";
import { SkiptraceStepRoles } from "../components/SkiptraceStepRoles";
import { SkiptraceCopies, SkiptraceStepSave } from "../components/SkiptraceStepSave";
import { SkiptraceStepSigns } from "../components/SkiptraceStepSigns";
import { useVisited } from "../lib/hooks";
import { formatNumber } from "../lib/marks";
import { STEPS, scrollInPane, useSkiptraceSetup, type ReadySetup } from "../lib/skiptrace-setup";
import { STAGE_LABELS } from "../lib/skiptrace-workflow";
import type { Dataset } from "../lib/types";

export function SkipTracing({ callerwhale }: { callerwhale: CallerWhale }) {
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const selected = callerwhale.datasets.find(item => item.id === callerwhale.selectedId) ?? null;
  // The setup belongs to the list itself; a checked copy points back to it.
  const target = selected?.kind === "checked" ? (callerwhale.datasets.find(item => item.id === selected.parent_dataset_id) ?? selected) : selected;
  // The setup and results of lists checked lately stay alive, so coming back does not ask the service again.
  const kept = useVisited(
    target?.id ?? null,
    callerwhale.datasets.map(item => item.id),
  );
  return (
    <div className="split skiptrace-workspace">
      <button
        type="button"
        className="button ghost skiptrace-list-toggle"
        aria-expanded={listPickerOpen}
        aria-controls="skiptrace-list-picker"
        onClick={() => setListPickerOpen(open => !open)}
      >
        {listPickerOpen ? "Close lists" : `Switch list${target ? ` · ${target.name}` : ""}`}
      </button>
      <div id="skiptrace-list-picker" className="skiptrace-list-rail" data-open={listPickerOpen}>
        <ListPicker
          datasets={callerwhale.datasets.filter(item => item.kind !== "checked")}
          selectedId={target?.id ?? null}
          onSelect={id => {
            callerwhale.select(id);
            setListPickerOpen(false);
          }}
          onImported={async id => {
            await callerwhale.refresh();
            callerwhale.select(id);
            setListPickerOpen(false);
          }}
          menuFor={item => [
            { label: "Check this list", disabled: item.id === target?.id, onSelect: () => callerwhale.select(item.id) },
            { label: "Open in Lists", onSelect: () => callerwhale.open("lists", item.id) },
            { label: "Copy its name", onSelect: () => copyText(item.name) },
          ]}
        />
      </div>
      {kept.map(id => (
        <div key={id} className="kept" hidden={id !== target?.id}>
          <Setup callerwhale={callerwhale} dataset={callerwhale.datasets.find(item => item.id === id)!} />
        </div>
      ))}
      {!target && <Empty title="No lists yet">Import a file to check its phone numbers.</Empty>}
    </div>
  );
}

/** One list's phone check: the heading, what is running, the five steps and the way between them. What the steps
 * share is in `useSkiptraceSetup`; each step is its own component. */
function Setup({ callerwhale, dataset }: { callerwhale: CallerWhale; dataset: Dataset }) {
  const view = useRef<HTMLElement>(null);
  const controller = useSkiptraceSetup(callerwhale, dataset);
  const { step, setStep, busy, statusBusy, stage, stopping, report, stale, hasPhones, saved, copy, error, draftError, missing } = controller;
  const previousStep = useRef(step);
  const loaded = Boolean(controller.setup);

  // A new step starts at its top, with its heading ready for a screen reader.
  useEffect(() => {
    if (!view.current || view.current.closest("[hidden]")) return;
    if (previousStep.current !== step) {
      scrollInPane(view.current.querySelector<HTMLElement>(".stepper"));
      previousStep.current = step;
    }
    const heading = view.current.querySelector<HTMLElement>(".wizard-step:not([hidden]) h2");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [step, loaded]);

  // In a narrow window the steps scroll sideways; the one in use stays in sight.
  useEffect(() => {
    const reveal = () => {
      const strip = view.current?.querySelector<HTMLElement>(".stepper");
      const selected = strip?.querySelector<HTMLElement>('[aria-current="step"]');
      if (!strip || !selected) return;
      const bounds = strip.getBoundingClientRect(),
        button = selected.getBoundingClientRect();
      if (button.right > bounds.right) strip.scrollLeft += button.right - bounds.right + 8;
      else if (button.left < bounds.left) strip.scrollLeft -= bounds.left - button.left + 8;
    };
    reveal();
    window.addEventListener("resize", reveal);
    return () => window.removeEventListener("resize", reveal);
  }, [step, loaded]);

  if (!controller.setup || !controller.base || !controller.config)
    return error ? (
      <p className="notice" role="alert">
        {error}
      </p>
    ) : (
      <p className="loading">Reading the setup…</p>
    );
  const s = controller as ReadySetup;
  const { setup, configKey, savedConfigKey, questionableColumns, importingLegacy, freshnessPending } = s;
  const reachable = (index: number) => index === 0 || (index <= 2 ? hasPhones : Boolean(report));

  return (
    <section className="list-view skiptrace" ref={view}>
      <header className="list-head">
        <div>
          <h1>{dataset.name}</h1>
          <p>
            {formatNumber(setup.rows)} rows ·{" "}
            {savedConfigKey === configKey ? "Setup saved with this list" : savedConfigKey ? "Setup edited since saving" : "Setup proposed from the columns"}
            {copy && (
              <>
                {" "}
                ·{" "}
                <button type="button" className="link" onClick={() => callerwhale.open("lists", copy.id)}>
                  Open the checked copy
                </button>
              </>
            )}
          </p>
        </div>
      </header>
      <p className="lede">Choose your phone columns, review any call evidence, then check the numbers. Your original list stays unchanged.</p>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {draftError && (
        <p className="notice" role="alert">
          {draftError}
        </p>
      )}
      {!draftError && <p className="sr-only">Your draft is kept on this computer for this project and list, including when you switch lists or reload.</p>}
      {missing.length > 0 && (
        <p className="notice" role="alert">
          This saved draft references missing columns: {missing.join(", ")}.{" "}
          <button type="button" className="button ghost" onClick={s.restore}>
            Restore this list's suggested or saved setup
          </button>
        </p>
      )}
      {busy && (
        <div className="notice" role="status" aria-live="polite">
          <span>
            {STAGE_LABELS[stage.stage] ?? stage.stage}
            {stage.total !== undefined && (
              <>
                {" "}
                · {formatNumber(stage.completed ?? 0)} of {formatNumber(stage.total)} {stage.stage === "finding_duplicates" ? "pairs compared" : "rows"}
              </>
            )}
            {stopping && " · Stopping at the next safe checkpoint…"}
          </span>
          {stage.total !== undefined && <progress max={Math.max(1, stage.total)} value={stage.completed ?? 0} aria-label="Phone check progress" />}
          <button type="button" className="button ghost" disabled={!s.jobId || stopping} onClick={() => void s.stop()}>
            {stopping ? "Stopping…" : "Stop"}
          </button>
        </div>
      )}

      {Object.keys(callerwhale.legacyManual).length > 0 && !s.legacyImported && (
        <div className="notice">
          <span>
            Earlier computer-wide marks are still stored separately. Import them into this project before checking if they belong here; existing project
            evidence and removals take precedence.
          </span>
          <button type="button" className="button ghost" disabled={busy !== null || importingLegacy} onClick={() => void s.importLegacy()}>
            Import earlier marks
          </button>
        </div>
      )}

      <ol className="stepper" aria-label="Steps">
        {STEPS.map((label, index) => (
          <li key={label}>
            <button
              type="button"
              disabled={!reachable(index) || busy !== null || statusBusy}
              aria-current={step === index ? "step" : undefined}
              onClick={() => setStep(index)}
            >
              <b>{index + 1}</b>
              {label}
            </button>
          </li>
        ))}
      </ol>
      {step !== 0 && questionableColumns.length > 0 && !hasPhones && (
        <p className="notice" role="alert">
          Confirm the identifier-like phone field before continuing.{" "}
          <button type="button" className="link" onClick={() => setStep(0)}>
            Review column roles
          </button>
        </p>
      )}

      <fieldset className="workflow-inputs" hidden={step > 2} disabled={busy !== null || statusBusy || importingLegacy}>
        <legend className="sr-only">Phone-check setup</legend>
        <SkiptraceStepRoles s={s} />
        <SkiptraceStepOutcomes s={s} />
        <SkiptraceStepSigns s={s} />
      </fieldset>

      {report && report.outcomes && (
        <>
          <SkiptraceStepResults key={report.scan_job_id} s={s} report={report} />
          <SkiptraceStepSave s={s} report={report} />
        </>
      )}

      <div className="wizard-step" hidden={step !== 3}>
        <ManualEvidence callerwhale={callerwhale} />
      </div>
      <SkiptraceCopies s={s} />

      <footer className="wizard-nav">
        <button type="button" className="button ghost" disabled={step === 0 || busy !== null || statusBusy} onClick={() => setStep(step - 1)}>
          Back
        </button>
        <span className="muted">
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </span>
        {step < 2 && (
          <button type="button" className="button" disabled={!hasPhones || busy !== null || statusBusy || importingLegacy} onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
        {step === 2 && !hasPhones && (
          <button type="button" className="button" onClick={() => setStep(0)}>
            Review column roles
          </button>
        )}
        {step === 2 && hasPhones && (
          <div className="row">
            {report && !stale && (
              <button type="button" className="button ghost" onClick={() => setStep(3)}>
                See the last results
              </button>
            )}
            <button type="button" className="button" disabled={!hasPhones || busy !== null || statusBusy || importingLegacy} onClick={() => void s.check()}>
              {busy === "scan" ? "Checking…" : report ? "Check again" : "Check phone numbers"}
            </button>
          </div>
        )}
        {step === 3 &&
          (!hasPhones ? (
            <button type="button" className="button" onClick={() => setStep(0)}>
              Review column roles
            </button>
          ) : (
            <button type="button" className="button" disabled={stale || busy !== null || freshnessPending} onClick={() => setStep(4)}>
              Next
            </button>
          ))}
        {step === 4 &&
          report &&
          (saved ? (
            <button type="button" className="button" onClick={() => callerwhale.open("lists", saved.dataset_id)}>
              Open in Lists
            </button>
          ) : (
            <button type="button" className="button" disabled={busy !== null || stale || freshnessPending || !hasPhones} onClick={() => void s.saveCopy()}>
              {busy === "apply" ? "Saving…" : "Save checked copy"}
            </button>
          ))}
      </footer>
    </section>
  );
}
