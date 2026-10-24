import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Turf } from "../App";
import { Empty, Segmented, VerdictPill } from "../components/Bits";
import { copyText } from "../components/ContextMenu";
import { LeadPanel } from "../components/LeadPanel";
import { ListPicker } from "../components/ListPicker";
import { phoneChoices } from "../components/PhoneChoices";
import { PropertyPhoto } from "../components/PropertyPhoto";
import { callingWindow } from "../lib/calling";
import { marksSource, useListSetups, useRows } from "../lib/hooks";
import { formatNumber, formatPhone, ownColumns, readMarks } from "../lib/marks";
import { ownerColumns, ownerFacts } from "../lib/owners";
import { photoColumns, photosOfRow, positionOf } from "../lib/photos";
import { callingZones, listLeads, localDay, recordLeadCall, setLead, STAGE_LABELS, STAGES, type LeadState, type ListLeads, type Stage } from "../lib/service";
import { FollowUpRules } from "../components/FollowUpRules";
import type { Dataset, DatasetRow } from "../lib/types";

const OUTCOMES = [
  { id: "reached", label: "Reached", next: false },
  { id: "voicemail", label: "Voicemail", next: true },
  { id: "no_answer", label: "No answer", next: true },
  { id: "wrong_number", label: "Wrong number", next: true },
  { id: "disconnected", label: "Disconnected", next: true },
] as const;
const OUTCOME_SAID: Record<string, string> = {
  reached: "reached a person",
  voicemail: "voicemail",
  no_answer: "no answer",
  wrong_number: "wrong number",
  disconnected: "disconnected",
};
type View = "queue" | "due" | "later" | "all" | "board";

/**
 * The leads of a list, one at a time, to call: the best number first, what time it is there, how the call went,
 * where the lead stands and when to call it again. A list is worked from its phone check, so a lead is here once,
 * with a number worth calling.
 */
export function Calls({ turf }: { turf: Turf }) {
  const selected = turf.datasets.find(item => item.id === turf.selectedId) ?? null;
  return (
    <div className="split">
      <ListPicker
        datasets={turf.datasets.filter(item => item.kind !== "checked")}
        selectedId={selected?.kind === "checked" ? (selected.parent_dataset_id ?? selected.id) : (selected?.id ?? null)}
        onSelect={turf.select}
        onImported={async id => {
          await turf.refresh();
          turf.select(id);
        }}
        menuFor={item => [
          { label: "Call this list", onSelect: () => turf.select(item.id) },
          { label: "Open in Lists", onSelect: () => turf.open("lists", item.id) },
          { label: "Check its phones in Skip Tracing", onSelect: () => turf.open("skiptracing", item.id) },
        ]}
      />
      {selected ? (
        <Queue key={marksSource(selected, turf.datasets).id} turf={turf} dataset={selected} />
      ) : (
        <Empty title="No lists yet">Add a list, check its phones, and call it here.</Empty>
      )}
    </div>
  );
}

function Queue({ turf, dataset }: { turf: Turf; dataset: Dataset }) {
  const source = marksSource(dataset, turf.datasets);
  const rows = useRows(source.id, turf.fail);
  const [leads, setLeads] = useState<ListLeads | null>(null);
  const [view, setView] = useState<View>("queue");
  const [at, setAt] = useState<number | null>(null);
  // Rows called since the queue was opened: they leave it, so the next one comes up.
  const [done, setDone] = useState<Record<number, string>>({});
  // Calls recorded here, so the lead panel reads its history again.
  const [calls, setCalls] = useState(0);
  // Rows that have left the queue for now: called without an answer, or called and moved on from.
  const [left, setLeft] = useState<Record<number, true>>({});
  // Where the lead in view stood in the list, so moving on from one that has left the list goes to its neighbour.
  const spot = useRef(0);
  const [zones, setZones] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState(false);
  const setups = useListSetups(turf.datasets, turf.version);
  const today = localDay();
  const fail = turf.fail;

  useEffect(() => {
    let live = true;
    listLeads(source.id).then(found => live && setLeads(found), fail);
    return () => {
      live = false;
    };
  }, [source.id, fail]);

  const columns = useMemo(() => (rows?.[0] ? Object.keys(rows[0].raw) : []), [rows]);
  const own = useMemo(() => ownColumns(columns), [columns]);
  const checked = columns.includes("Best phone");
  const original = dataset.kind === "checked" ? (dataset.parent_dataset_id ?? dataset.id) : dataset.id;
  const owner = useMemo(() => ownerColumns(columns, setups[original], turf.areaMaps[original]), [columns, setups, original, turf.areaMaps]);
  const pictures = useMemo(() => photoColumns(rows ?? [], own), [rows, own]);
  const stateOf = useCallback((row: DatasetRow): LeadState | undefined => (leads ? leads.states[leads.keys[String(row.row_number)]] : undefined), [leads]);

  // Each lead once, with a number to call. Where it goes depends on where it stands.
  const sorted = useMemo(() => {
    const groups: Record<View, DatasetRow[]> = { queue: [], due: [], later: [], all: [], board: [] };
    if (!rows || !leads) return groups;
    const seen = new Set<string>();
    const fresh: DatasetRow[] = [];
    for (const row of rows) {
      const marks = readMarks(row.raw, [], turf.manual);
      if (!marks.best || String(row.raw["Duplicate status"] ?? "").startsWith("Duplicate of")) continue;
      const key = leads.keys[String(row.row_number)];
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      groups.all.push(row);
      const state = leads.states[key];
      if (state?.stage === "dead" || state?.stage === "not_interested") continue;
      if (state?.callback_on && state.callback_on.slice(0, 10) > today) groups.later.push(row);
      else if (state?.callback_on) groups.due.push(row);
      else if (!left[row.row_number]) fresh.push(row);
    }
    const when = (row: DatasetRow) => stateOf(row)?.callback_on ?? "";
    groups.due.sort((a, b) => when(a).localeCompare(when(b)));
    groups.later.sort((a, b) => when(a).localeCompare(when(b)));
    // Callbacks that are due come before leads not called yet.
    groups.queue = [...groups.due.filter(row => !left[row.row_number]), ...fresh];
    return groups;
  }, [rows, leads, turf.manual, today, left, stateOf]);

  // A callback opened from the Dashboard goes straight to its lead.
  const target = turf.callTarget?.datasetId === source.id || turf.callTarget?.datasetId === dataset.id ? turf.callTarget.rowNumber : null;
  useEffect(() => {
    if (target === null || !rows) return;
    setView("all");
    setAt(target);
    turf.clearCallTarget();
  }, [target, rows, turf]);

  const list = view === "board" ? sorted.all : sorted[view];
  // The lead being worked stays in view while it is worked, even once what was set (a callback, a stage) takes it
  // out of the list it was opened from.
  const current = list.find(row => row.row_number === at) ?? (at !== null ? sorted.all.find(row => row.row_number === at) : undefined) ?? list[0] ?? null;
  const position = current ? list.indexOf(current) : -1;
  if (position >= 0) spot.current = position;
  const choices = useMemo(() => (current ? phoneChoices(current.raw) : []), [current]);
  const numbers = useMemo(() => choices.map(choice => choice.number).filter((value): value is string => Boolean(value)), [choices]);
  const wanted = numbers.filter(number => !(number in zones)).join();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    callingZones(wanted.split(",")).then(
      found => live && setZones(known => ({ ...known, ...found })),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [wanted]);

  if (!rows || !leads) return <p className="loading">Reading the list…</p>;
  if (!checked)
    return (
      <Empty title="Check this list's phones first">
        Calling works from a phone check: it finds the number worth calling in each row, leaves out wrong and do-not-call numbers, and marks repeated leads.{" "}
        <button type="button" className="link" onClick={() => turf.open("skiptracing", original)}>
          Check its phones in Skip Tracing
        </button>
      </Empty>
    );

  const go = (step: number) => {
    // From a lead that has left the list, forward is the lead that took its place.
    const next = position >= 0 ? list[position + step] : list[Math.max(0, spot.current + (step > 0 ? 0 : -1))];
    if (current && done[current.row_number]) setLeft(known => ({ ...known, [current.row_number]: true }));
    setAt(next ? next.row_number : null);
    setFields(false);
  };
  /** A lead's new state, without moving to it. */
  const remember = (row: DatasetRow, state: LeadState) =>
    setLeads(known => (known ? { ...known, states: { ...known.states, [known.keys[String(row.row_number)]]: state } } : known));
  const keep = (row: DatasetRow, state: LeadState) => {
    setAt(row.row_number);
    setLeads(known => (known ? { ...known, states: { ...known.states, [known.keys[String(row.row_number)]]: state } } : known));
  };

  async function called(row: DatasetRow, number: string, outcome: (typeof OUTCOMES)[number]) {
    setBusy(true);
    try {
      // The service records the call and does what the follow-up rules say (a callback after no answer, a new lead
      // reached becomes contacted), and says what it did.
      const result = await recordLeadCall({ dataset_id: source.id, row_number: row.row_number }, number, outcome.id);
      remember(row, result.state);
      setCalls(count => count + 1);
      const said = OUTCOME_SAID[outcome.id] + (result.rules.length ? `, then ${result.rules.join(" and ")}` : "");
      if (outcome.next) {
        const next = list[position + 1];
        setDone(known => ({ ...known, [row.row_number]: said }));
        setLeft(known => ({ ...known, [row.row_number]: true }));
        setAt(next ? next.row_number : null);
        setFields(false);
      } else {
        // Someone is on the line: the lead stays in view for its stage, a note and a callback.
        setAt(row.row_number);
        setDone(known => ({ ...known, [row.row_number]: said }));
      }
    } catch (reason) {
      fail(reason);
    }
    setBusy(false);
  }

  const facts = current ? ownerFacts(current, owner) : null;
  const cell = (row: DatasetRow, column?: string) => (column ? String(row.raw[column] ?? "").trim() : "");
  const place = current
    ? [
        cell(current, owner.place.street),
        cell(current, owner.place.city),
        [cell(current, owner.state), cell(current, owner.place.zip)].filter(Boolean).join(" "),
      ]
    : [];
  const state = current ? stateOf(current) : undefined;

  return (
    <section className="list-view calls">
      <header className="list-head">
        <div>
          <h1>{dataset.kind === "checked" ? (turf.datasets.find(item => item.id === dataset.parent_dataset_id)?.name ?? dataset.name) : dataset.name}</h1>
          <p>
            {formatNumber(sorted.queue.length)} to call now · {formatNumber(sorted.due.length)} {sorted.due.length === 1 ? "callback" : "callbacks"} due ·{" "}
            {formatNumber(sorted.later.length)} for later · {formatNumber(Object.keys(done).length)} called since you opened this
          </p>
        </div>
        <Segmented
          label="Which leads"
          value={view}
          onChange={value => {
            setView(value);
            setAt(null);
          }}
          options={[
            { value: "queue", label: `To call (${formatNumber(sorted.queue.length)})` },
            { value: "due", label: `Callbacks due (${formatNumber(sorted.due.length)})` },
            { value: "later", label: `Later (${formatNumber(sorted.later.length)})` },
            { value: "all", label: `All (${formatNumber(sorted.all.length)})` },
            { value: "board", label: "Board" },
          ]}
        />
      </header>

      <FollowUpRules fail={fail} />
      {view === "board" ? (
        <LeadBoard
          rows={sorted.all}
          stateOf={stateOf}
          label={row => {
            const facts = ownerFacts(row, owner);
            return [facts.name, String(row.raw[owner.place.street ?? ""] ?? "").trim()].filter(Boolean).join(" · ") || `Row ${row.row_number}`;
          }}
          onOpen={row => {
            setView("all");
            setAt(row.row_number);
          }}
          onMove={(row, stage) => void setLead({ dataset_id: source.id, row_number: row.row_number }, { stage }).then(next => remember(row, next), fail)}
        />
      ) : !current ? (
        <Empty title={view === "queue" ? "Nothing left to call here" : "No lead here"}>
          {view === "queue"
            ? "Every lead with a number to call has been called, set aside for later, or closed. Callbacks come back on their day."
            : "Leads show here when they fit this view."}
        </Empty>
      ) : (
        <article className="card call-card">
          <header>
            <div className="call-who">
              <div className="call-photo">
                <PropertyPhoto
                  photos={photosOfRow(current, pictures)}
                  position={positionOf(current, owner.place)}
                  label={place[0] || `Row ${current.row_number}`}
                  aerial
                />
              </div>
              <div>
                <h2>{facts?.name || place[0] || `Row ${current.row_number}`}</h2>
                <p>{place.filter(Boolean).join(", ") || "No property address"}</p>
                <p className="muted">
                  Row {current.row_number} · {STAGE_LABELS[state?.stage ?? "new"]}
                  {state?.callback_on && ` · call back ${state.callback_on}${state.callback_note ? `: ${state.callback_note}` : ""}`}
                  {done[current.row_number] && ` · just now: ${done[current.row_number]}`}
                  {facts?.absentee && " · absentee owner"}
                </p>
              </div>
            </div>
            <div className="row nowrap">
              <span className="count">{position >= 0 ? `${position + 1} of ${formatNumber(list.length)}` : "Set aside"}</span>
              <button type="button" className="button ghost small" disabled={position === 0 || (position < 0 && spot.current === 0)} onClick={() => go(-1)}>
                Previous
              </button>
              <button type="button" className="button small" disabled={position >= 0 ? position >= list.length - 1 : !list.length} onClick={() => go(1)}>
                Next
              </button>
            </div>
          </header>

          <ul className="call-numbers">
            {choices.map((choice, index) => {
              const number = choice.number;
              const window = number ? callingWindow(zones[number]) : null;
              const blocked = choice.blocked || choice.quality === "wrong";
              return (
                <li key={`${choice.raw}-${index}`} className={blocked ? "blocked" : undefined}>
                  <div className="call-number">
                    {number && !blocked ? (
                      <a className="call-dial" href={`tel:${number}`} onContextMenu={() => copyText(number)}>
                        {formatPhone(number)}
                        {choice.extension ? ` ext. ${choice.extension}` : ""}
                      </a>
                    ) : (
                      <strong className="muted">{formatPhone(number) || choice.raw}</strong>
                    )}
                    <VerdictPill verdict={choice.quality} />
                    {index === 0 && !blocked && <span className="pill pill-corroborated">Call first</span>}
                    {choice.permission === "blocked_dnc" && <span className="pill pill-wrong">Do not call</span>}
                  </div>
                  <small className="muted">
                    {[choice.type, choice.column, choice.explanations?.[0]].filter(Boolean).join(" · ")}
                    {choice.last_outcome &&
                      ` · last: ${choice.last_outcome.outcome.replace("_", " ")}${choice.last_outcome.occurred_at ? ` on ${choice.last_outcome.occurred_at.slice(0, 10)}` : ""}`}
                  </small>
                  {window && !blocked && <small className={window.state === "closed" ? "call-window closed" : "call-window muted"}>{window.text}</small>}
                  {number && !blocked && (
                    <div className="row">
                      {OUTCOMES.map(outcome => (
                        <button
                          key={outcome.id}
                          type="button"
                          className="button ghost small"
                          disabled={busy}
                          onClick={() => void called(current, number, outcome)}
                        >
                          {outcome.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="button ghost small"
                        disabled={busy}
                        onClick={() => {
                          turf.setMark(number, "do_not_call");
                          setDone(known => ({ ...known, [current.row_number]: "do not call" }));
                        }}
                      >
                        Do not call
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <LeadPanel
            datasetId={source.id}
            rowNumber={current.row_number}
            state={state}
            onChanged={next => keep(current, next)}
            onError={fail}
            refresh={calls}
          />

          <details className="step skiptrace-optional" open={fields} onToggle={event => setFields(event.currentTarget.open)}>
            <summary>Everything the list has on this lead</summary>
            {fields && (
              <dl className="review-fields">
                {own.map(column => (
                  <div key={column}>
                    <dt>{column}</dt>
                    <dd>{String(current.raw[column] ?? "–") || "–"}</dd>
                  </div>
                ))}
              </dl>
            )}
          </details>
        </article>
      )}
    </section>
  );
}

const SHOWN_PER_STAGE = 60;

/**
 * The leads of a list by stage, a column each, to see the pipeline at a glance and move a lead from one stage to the
 * next by dragging its card. A column shows its first leads and how many it holds.
 */
function LeadBoard({
  rows,
  stateOf,
  label,
  onOpen,
  onMove,
}: {
  rows: DatasetRow[];
  stateOf: (row: DatasetRow) => LeadState | undefined;
  label: (row: DatasetRow) => string;
  onOpen: (row: DatasetRow) => void;
  onMove: (row: DatasetRow, stage: Stage) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<Stage | null>(null);
  const columns = useMemo(() => {
    const found = Object.fromEntries(STAGES.map(stage => [stage, [] as DatasetRow[]])) as Record<Stage, DatasetRow[]>;
    for (const row of rows) found[stateOf(row)?.stage ?? "new"].push(row);
    return found;
  }, [rows, stateOf]);
  return (
    <div className="lead-board" role="list" aria-label="Leads by stage">
      {STAGES.map(stage => (
        <section
          key={stage}
          role="listitem"
          aria-label={STAGE_LABELS[stage]}
          className={over === stage ? "board-column over" : "board-column"}
          onDragOver={event => {
            event.preventDefault();
            setOver(stage);
          }}
          onDragLeave={() => setOver(null)}
          onDrop={event => {
            event.preventDefault();
            setOver(null);
            const row = rows.find(item => item.row_number === dragging);
            if (row && (stateOf(row)?.stage ?? "new") !== stage) onMove(row, stage);
            setDragging(null);
          }}
        >
          <header>
            <h3>{STAGE_LABELS[stage]}</h3>
            <span className="count">{formatNumber(columns[stage].length)}</span>
          </header>
          <ul>
            {columns[stage].slice(0, SHOWN_PER_STAGE).map(row => {
              const state = stateOf(row);
              return (
                <li key={row.id} draggable onDragStart={() => setDragging(row.row_number)} onDragEnd={() => setDragging(null)}>
                  <button type="button" className="board-card" onClick={() => onOpen(row)}>
                    <strong>{label(row)}</strong>
                    {state?.callback_on && <small>Call back {state.callback_on.replace("T", " at ")}</small>}
                  </button>
                  <select
                    className="board-move"
                    aria-label={`Move ${label(row)} to another stage`}
                    value={state?.stage ?? "new"}
                    onChange={event => onMove(row, event.target.value as Stage)}
                  >
                    {STAGES.map(value => (
                      <option key={value} value={value}>
                        {STAGE_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </li>
              );
            })}
            {columns[stage].length > SHOWN_PER_STAGE && <li className="muted">and {formatNumber(columns[stage].length - SHOWN_PER_STAGE)} more</li>}
          </ul>
        </section>
      ))}
    </div>
  );
}
