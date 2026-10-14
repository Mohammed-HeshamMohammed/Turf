import { useEffect, useState } from "react";
import {
  addLeadNote,
  describeHistory,
  getLead,
  leadHistory,
  leadNotes,
  localDay,
  removeLeadNote,
  setLead,
  STAGE_LABELS,
  STAGES,
  type HistoryItem,
  type LeadNote,
  type LeadState,
  type Stage,
} from "../lib/service";
import { Segmented } from "./Bits";

const later = (days: number) => {
  const day = new Date();
  day.setDate(day.getDate() + days);
  return localDay(day);
};

/**
 * Where a lead stands: its stage, when to call it again, and the notes on it. What is set here belongs to the lead
 * (its property, or its phone), so it shows on the same lead in every list.
 */
export function LeadPanel({
  datasetId,
  rowNumber,
  state,
  onChanged,
  onError,
  refresh = 0,
}: {
  datasetId: string;
  rowNumber: number;
  state: LeadState | undefined;
  /** Told the lead's new state after every change, so lists and counts that show it can follow. */
  onChanged: (state: LeadState) => void;
  onError: (reason: unknown) => void;
  /** Bumped by whoever records something else on the lead (a call), so its history is read again. */
  refresh?: number;
}) {
  const row = { dataset_id: datasetId, row_number: rowNumber };
  const [notes, setNotes] = useState<LeadNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [about, setAbout] = useState(state?.callback_note ?? "");
  const current: LeadState = state ?? { stage: "new", callback_on: null, callback_note: "" };
  useEffect(() => {
    let live = true;
    setNotes(null);
    setDraft("");
    leadNotes({ dataset_id: datasetId, row_number: rowNumber }).then(list => live && setNotes(list), onError);
    return () => {
      live = false;
    };
  }, [datasetId, rowNumber, onError]);
  useEffect(() => setAbout(state?.callback_note ?? ""), [state?.callback_note, rowNumber]);
  // Everything that happened to the lead, read again after each change made here or elsewhere.
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const changes = `${state?.stage}|${state?.callback_on}|${state?.callback_note}|${notes?.length}|${refresh}`;
  useEffect(() => {
    if (!showHistory) return;
    let live = true;
    leadHistory({ dataset_id: datasetId, row_number: rowNumber }).then(found => live && setHistory(found), onError);
    return () => {
      live = false;
    };
  }, [datasetId, rowNumber, onError, showHistory, changes]);
  const day = current.callback_on?.slice(0, 10) ?? "";
  const time = current.callback_on?.slice(11, 16) ?? "";

  const change = (value: Parameters<typeof setLead>[1]) => void setLead(row, value).then(onChanged, onError);

  return (
    <div className="lead-panel">
      <div className="lead-line">
        <span className="lead-label">Stage</span>
        <Segmented
          label="Stage"
          value={current.stage}
          onChange={(stage: Stage) => change({ stage })}
          options={STAGES.map(value => ({ value, label: STAGE_LABELS[value] }))}
        />
      </div>
      <div className="lead-line">
        <span className="lead-label">Call back</span>
        <input
          className="input"
          type="date"
          aria-label="Call back on"
          value={day}
          onChange={event =>
            change({ callback_on: event.target.value ? (time ? `${event.target.value}T${time}` : event.target.value) : null, callback_note: about })
          }
        />
        {day && (
          <input
            className="input"
            type="time"
            aria-label="Call back at"
            value={time}
            onChange={event => change({ callback_on: event.target.value ? `${day}T${event.target.value}` : day, callback_note: about })}
          />
        )}
        <button type="button" className="button ghost small" onClick={() => change({ callback_on: later(1), callback_note: about })}>
          Tomorrow
        </button>
        <button type="button" className="button ghost small" onClick={() => change({ callback_on: later(7), callback_note: about })}>
          In a week
        </button>
        {current.callback_on && (
          <>
            <input
              className="input grow"
              value={about}
              placeholder="What the callback is about"
              aria-label="What the callback is about"
              onChange={event => setAbout(event.target.value)}
              onBlur={() => about !== current.callback_note && change({ callback_note: about })}
            />
            <button type="button" className="link" onClick={() => change({ callback_on: null })}>
              No callback
            </button>
          </>
        )}
      </div>
      <form
        className="lead-line"
        onSubmit={event => {
          event.preventDefault();
          if (draft.trim()) void addLeadNote(row, draft).then(list => (setNotes(list), setDraft("")), onError);
        }}
      >
        <span className="lead-label">Notes</span>
        <input
          className="input grow"
          value={draft}
          placeholder="Add a note on this lead"
          aria-label="Note on this lead"
          onChange={event => setDraft(event.target.value)}
        />
        <button type="submit" className="button small" disabled={!draft.trim()}>
          Add note
        </button>
      </form>
      {notes && notes.length > 0 && (
        <ul className="lead-notes">
          {notes.map(note => (
            <li key={note.id}>
              <span>{note.note}</span>
              <small className="muted">{new Date(note.at).toLocaleString()}</small>
              <button type="button" className="link" onClick={() => void removeLeadNote(row, note.id).then(setNotes, onError)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="lead-history" onToggle={event => setShowHistory(event.currentTarget.open)}>
        <summary>History</summary>
        {showHistory && !history && <p className="muted">Reading the history…</p>}
        {history && !history.length && <p className="muted">Nothing has happened to this lead yet.</p>}
        {history && history.length > 0 && (
          <ol>
            {history.map((item, index) => (
              <li key={`${item.at}-${index}`} className={`history-${item.kind}`}>
                <small className="muted">{new Date(item.at).toLocaleString()}</small>
                <span>{describeHistory(item)}</span>
                {item.list && <small className="muted">{item.list}</small>}
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

/** The lead panel for one row of a list, where the row's lead is not known yet: it is asked for, then shown. */
export function LeadOfRow({ datasetId, rowNumber, onError }: { datasetId: string; rowNumber: number; onError: (reason: unknown) => void }) {
  const [state, setState] = useState<LeadState | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setState(undefined);
    getLead({ dataset_id: datasetId, row_number: rowNumber }).then(found => live && setState(found.state), onError);
    return () => {
      live = false;
    };
  }, [datasetId, rowNumber, onError]);
  if (state === undefined) return null;
  return <LeadPanel datasetId={datasetId} rowNumber={rowNumber} state={state ?? undefined} onChanged={setState} onError={onError} />;
}
