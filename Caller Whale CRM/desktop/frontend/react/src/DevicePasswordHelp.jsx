import { Check, Circle } from "@phosphor-icons/react";
import { assess, EXAMPLE, MAX_LENGTH } from "./remote/password-check.ts";

// Beside the field that sets the offline password: on the left how to choose a good one, on the right how strong the one typed is.

const TONE = ["", "weak", "fair", "good", "strong"];

export function DevicePasswordHelp({ value }) {
  const result = assess(value);
  return (
    <div className="device-password-help">
      <div className="dph-tips">
        <strong>How to choose a good one</strong>
        <p>
          Long and simple beats short and clever. Pick three or four ordinary words that mean something to you, like <em>{EXAMPLE}</em>. That one is taken, so
          make up your own.
        </p>
        <ul>
          <li>Longer is stronger: 16 characters or more is best (up to {MAX_LENGTH}).</li>
          <li>Words you can picture are easier to remember than symbols.</li>
          <li>Do not reuse your Caller Whale or email password.</li>
        </ul>
      </div>
      <div className="dph-strength" aria-live="polite">
        <strong>
          Strength: <span className={`dph-label ${TONE[result.score]}`}>{result.label || "not set yet"}</span>
        </strong>
        <div className="dph-meter" role="img" aria-label={result.label ? `Strength: ${result.label}` : "Strength: not set yet"}>
          {[1, 2, 3, 4].map((step) => (
            <span key={step} className={result.score >= step ? `on ${TONE[result.score]}` : ""} />
          ))}
        </div>
        <ul className="dph-checks">
          {result.checks.map((check) => (
            <li key={check.label} className={check.pass ? "pass" : ""}>
              {check.pass ? <Check size={14} weight="bold" aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
              <span>{check.label}</span>
              <span className="sr-only">{check.pass ? " (done)" : " (not yet)"}</span>
            </li>
          ))}
        </ul>
        {result.problem && value && <p className="dph-problem">{result.problem}</p>}
      </div>
    </div>
  );
}
