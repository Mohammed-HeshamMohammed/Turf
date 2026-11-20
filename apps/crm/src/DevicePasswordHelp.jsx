import { Check, Circle } from "@phosphor-icons/react";
import { assess, EXAMPLE, MAX_LENGTH } from "./remote/password-check.ts";

// Beside the card that sets the offline password: on its left how to choose a good one, on its right how strong the one typed is.
// On a narrow screen they sit under the card, the strength first, since that is what the person is watching as they type.

const TONE = ["", "weak", "fair", "good", "strong"];

export function PasswordTips() {
  return (
    <aside className="dph-side dph-tips" aria-label="How to choose a good password">
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
    </aside>
  );
}

export function PasswordStrength({ value }) {
  const result = assess(value);
  return (
    <aside className="dph-side dph-strength" aria-label="Password strength" aria-live="polite">
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
    </aside>
  );
}
