import { useEffect, useState } from "react";
import { call } from "../lib/service";
import { formatPhone } from "../lib/marks";
import type { PhoneChoice, Raw } from "../lib/types";
import { Field, VerdictPill } from "./Bits";

export function phoneChoices(raw: Raw): PhoneChoice[] {
  try { const parsed = JSON.parse(String(raw["Phone choices"] ?? "[]")); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

const OUTCOMES = [
  { value: "reached", label: "Reached a person" }, { value: "wrong_person", label: "Wrong person for this row" },
  { value: "disconnected", label: "Disconnected / not in service" }, { value: "voicemail", label: "Voicemail" },
  { value: "no_answer", label: "No answer" }, { value: "wrong_number", label: "Known wrong number (all rows)" },
];
type Event = { id: string; number: string; outcome: string; occurred_at: string; recorded_at: string; notes: string; source: string; retired_at: string | null; person_key: string | null };

export function CallOutcomeLog({ numbers = [], datasetId, rowNumber, onSaved }: {
  numbers?: string[]; datasetId?: string; rowNumber?: number; onSaved: () => Promise<void>;
}) {
  const [number, setNumber] = useState(numbers[0] ?? "");
  const [outcome, setOutcome] = useState("no_answer");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [events, setEvents] = useState<Event[]>([]);
  const [page, setPage] = useState(0);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { setPage(0); }, [number]);
  useEffect(() => {
    let current = true;
    call<Event[]>("phone.outcomes", { number: number || null, offset: page * 25, limit: 25 }).then(value => { if (current) setEvents(value); }, reason => { if (current) setError(String(reason)); });
    return () => { current = false; };
  }, [number, version, page]);
  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true); setError(null); setMessage("");
    try { await action(); await onSaved(); setVersion(value => value + 1); setMessage(message); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="phone-call-log">
    <h3>Dated call outcomes</h3>
    <p className="muted">Choose the exact number called. Voicemail and no answer record activity only. Wrong person applies to the named person in this row; disconnected and known wrong number apply across the project. Corrections keep the original history. New outcomes are used on your next check.</p>
    <form onSubmit={event => { event.preventDefault(); void act(() => call("phone.record_outcome", { number, outcome, occurred_at: when ? new Date(when).toISOString() : undefined, notes, dataset_id: datasetId, row_number: rowNumber }), "Call outcome saved. Check again to update recommendations."); }}>
      <fieldset disabled={busy}><div className="fields">
        {numbers.length ? <Field label="Number called" value={number} options={numbers.map(value => ({ value, label: formatPhone(value) }))} onChange={value => setNumber(value ?? "")} /> : <label className="field"><span>Number called (international format)</span><input className="input" value={number} placeholder="+17135553142" required onChange={event => setNumber(event.target.value)} /></label>}
        <Field label="Call result" value={outcome} options={OUTCOMES.filter(item => item.value !== "wrong_person" || datasetId)} onChange={value => setOutcome(value ?? "no_answer")} />
        <label className="field"><span>Call date and time (blank means now)</span><input className="input" type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></label>
        <label className="field"><span>Notes (optional)</span><textarea className="input" value={notes} maxLength={2000} onChange={event => setNotes(event.target.value)} /></label>
      </div><button type="submit" className="button" disabled={!number}>{busy ? "Saving…" : "Save call outcome"}</button></fieldset>
    </form>
    {error && <p className="notice" role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    <div className="table-wrap history-table"><table className="compact"><caption>Call history{number ? ` for ${formatPhone(number)}` : " in this project"}</caption><thead><tr><th>Number</th><th>Result and scope</th><th>Call date</th><th>Notes</th><th>Correction</th></tr></thead><tbody>{events.map(entry => <tr key={entry.id}><td>{formatPhone(entry.number)}</td><td>{OUTCOMES.find(item => item.value === entry.outcome)?.label ?? entry.outcome}<small className="muted">{entry.person_key ? "For this recorded person" : "Number evidence"} · {entry.source}</small></td><td>{new Date(entry.occurred_at).toLocaleString()}</td><td>{entry.notes}</td><td>{entry.retired_at ? `Retracted ${new Date(entry.retired_at).toLocaleString()}` : <button type="button" className="button ghost small" disabled={busy} onClick={() => void act(() => call("phone.retract_outcome", { id: entry.id }), "Record retracted; history preserved. Check again to update results.")}>Retract mistaken record</button>}</td></tr>)}</tbody></table></div>
    {!events.length && <p className="muted">No call records in this view.</p>}
    <div className="row"><button type="button" className="button ghost small" disabled={!page || busy} onClick={() => setPage(page - 1)}>Previous calls</button><span>Page {page + 1}</span><button type="button" className="button ghost small" disabled={events.length < 25 || busy} onClick={() => setPage(page + 1)}>Next calls</button></div>
  </section>;
}

export function PhoneChoices({ raw, datasetId, rowNumber, onSaved }: { raw: Raw; datasetId: string; rowNumber: number; onSaved: () => Promise<void> }) {
  const choices = phoneChoices(raw);
  const [logging, setLogging] = useState(false);
  if (!choices.length) return null;
  return <section className="phone-choices">
    <h3>Phone choices, in recommended order</h3>
    <p className="muted">Quality and calling restrictions are assessed separately. Unblocked numbers come first, then stronger evidence, fewer review warnings, and more recent successful calls; ties keep your column order. “No recorded block” means no active DNC evidence in this project; it does not establish permission to call. Older combined verdicts remain in the original phone-check fields.</p>
    <ol className="phone-choice-list">{choices.map(choice => <li key={`${choice.rank}-${choice.number ?? choice.raw}`}>
      <div className="row"><strong>{formatPhone(choice.number) || choice.raw}{choice.extension ? ` ext. ${choice.extension}` : ""}</strong><VerdictPill verdict={choice.quality} /><span className={`pill ${choice.permission === "blocked_dnc" ? "pill-wrong" : "pill-none"}`}>{choice.permission === "blocked_dnc" ? "Do not call" : "No recorded block"}</span><span>{choice.recommendation}</span></div>
      <p className="muted">{choice.columns.join(" · ")} · {choice.type ?? "Unknown type"} · {choice.valid_format ? "Valid number format" : "Invalid number format"}</p>
      <ul>{choice.explanations.map((text, index) => <li key={index}>{text}</li>)}</ul>
      {choice.lookup && <p className="muted">{choice.lookup.provider} · {new Date(choice.lookup.checked_at).toLocaleString()}{choice.lookup.stale ? " · Old result" : ""} · Carrier: {choice.lookup.carrier ?? "Unknown"} · Type: {choice.lookup.type ?? "Unknown"} · Line status: {choice.lookup.line_status}. Ownership is unverified.</p>}
    </li>)}</ol>
    <details onToggle={event => setLogging(event.currentTarget.open)}><summary>Record a call outcome or review its history</summary>{logging && <CallOutcomeLog numbers={[...new Set(choices.filter(choice => choice.valid_format && choice.number).map(choice => choice.number!))]} datasetId={datasetId} rowNumber={rowNumber} onSaved={onSaved} />}</details>
  </section>;
}
