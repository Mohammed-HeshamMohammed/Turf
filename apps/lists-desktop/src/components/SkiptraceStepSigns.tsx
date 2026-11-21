import { useState } from "react";
import type { ReadySetup } from "../lib/skiptrace-setup";
import { SIGN_HELP, signEvidence, signReadiness } from "../lib/skiptrace-workflow";
import { Check } from "./Bits";
import { Icon } from "./Icon";
import { PhoneLookup } from "./PhoneLookup";
import { SkiptraceReadiness } from "./SkiptraceReadiness";

/** Step 3: the warning signs that put a number up for review, what the check will use, and the optional lookup. */
export function SkiptraceStepSigns({ s }: { s: ReadySetup }) {
  const { base, config, report, signs, advice, outcomeColumn } = s;
  const [advancedLookup, setAdvancedLookup] = useState(false);
  return (
    <div className="wizard-step" hidden={s.step !== 2}>
      <article className="card step">
        <header>
          <h2>Warning signs</h2>
        </header>
        <p className="muted">
          Signs that put a number up for review. A sign is not proof that a number is wrong; where the list has call results, each check measures whether a sign
          really predicts wrong numbers here.
        </p>
        {advice.length > 0 && (
          <p className="notice sign-advice">
            <span>The last check of this list suggests turning {advice.map(item => `${item.on ? "on" : "off"} “${item.label}”`).join(" and ")}.</span>
            <button
              type="button"
              className="button small"
              onClick={() => s.patch({ signals: { ...base.signals, ...Object.fromEntries(advice.map(item => [item.code, item.on])) } })}
            >
              Use what the data shows
            </button>
          </p>
        )}
        <div className="sign-grid">
          {signs.map(sign => {
            const on = Boolean(base.signals[sign.code]);
            const ready = signReadiness(sign.code, base);
            const evidence = signEvidence(
              report?.signals.find(item => item.code === sign.code),
              report ? report.outcomes.available : Boolean(outcomeColumn),
            );
            return (
              <div key={sign.code} className={on ? "sign-card on" : "sign-card"}>
                <Check checked={on} onChange={value => s.patch({ signals: { ...base.signals, [sign.code]: value } })}>
                  <span className="sign-title">{sign.label}</span>
                </Check>
                <p className={ready.ready ? "sign-state ready" : "sign-state needs"}>
                  <Icon name={ready.ready ? "check" : "flag"} size={14} />
                  <span>{ready.ready ? ready.text : on ? `Can't work yet: ${ready.text.toLowerCase()}` : ready.text}</span>
                  {!ready.ready && (
                    <button type="button" className="link" onClick={() => s.setStep(0)}>
                      Map it
                    </button>
                  )}
                </p>
                <p className="sign-measured">{evidence.text}</p>
                <p className="sign-example muted">For example: {SIGN_HELP[sign.code]?.example}</p>
              </div>
            );
          })}
        </div>

        <SkiptraceReadiness
          base={base}
          outcomeColumn={outcomeColumn}
          called={s.called}
          unreviewed={s.unreviewed.length}
          statusCount={s.statuses.length}
          ignored={s.ignored.length}
          signs={signs}
          setStep={s.setStep}
          onEvidenceChanged={() => void s.callerwhale.refresh()}
        />

        <details className="step skiptrace-optional">
          <summary>More settings</summary>
          <div className="fields">
            <label className="field">
              <span>Review successful-call evidence after this many days</span>
              <input
                className="input"
                type="number"
                min="1"
                max="3650"
                value={base.evidence_age_days ?? 180}
                onChange={event => s.patch({ evidence_age_days: Number(event.target.value) })}
              />
            </label>
            <label className="field">
              <span>Flag live lookup results after this many days</span>
              <input
                className="input"
                type="number"
                min="1"
                max="365"
                value={base.lookup_age_days ?? 30}
                onChange={event => s.patch({ lookup_age_days: Number(event.target.value) })}
              />
            </label>
          </div>
          <p className="muted">Aging evidence prompts review; it does not prove reassignment.</p>
          <Check checked={base.find_duplicates !== false} onChange={on => s.patch({ find_duplicates: on })}>
            Also look for rows that repeat the same lead
          </Check>
          <p className="muted">
            The check then says which rows are the same lead written twice, which one to keep, and which owners are in the list with several properties. No row
            is removed.
          </p>
          <details className="step skiptrace-optional" onToggle={event => setAdvancedLookup(event.currentTarget.open)}>
            <summary>Optional external lookup</summary>
            <p className="muted">Dialer exports and normal phone checks work without an external provider.</p>
            {advancedLookup && <PhoneLookup datasetId={s.dataset.id} config={config} projectId={s.callerwhale.projectId} onUpdated={s.callerwhale.refresh} />}
          </details>
        </details>
      </article>
    </div>
  );
}
