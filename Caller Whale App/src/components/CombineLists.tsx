import { useState } from "react";
import type { CallerWhale } from "../App";
import { formatNumber } from "../lib/marks";
import { combineLists, compareLists, overrule, type CombineMode, type CombineSummary, type LeadRow } from "../lib/service";
import { Check, Field } from "./Bits";

const STAGES: Record<string, string> = {
  reading_lists: "Reading the lists",
  finding_duplicates: "Comparing the rows",
  writing_combined_list: "Putting each lead together",
  saving_combined_list: "Saving the combined list",
};

/**
 * Several lists made into one. The person picks the lists, Caller Whale compares their rows and says what they share, and
 * the person chooses what the new list holds: every lead once, only the ones the lists share, or only one list's
 * own. The lists themselves are not changed.
 */
export function CombineLists({ callerwhale, onDone, onCancel }: { callerwhale: CallerWhale; onDone: (datasetId: string) => void; onCancel: () => void }) {
  // A checked copy is its list with results added; the list itself is what is combined, and its check is used.
  const lists = callerwhale.datasets.filter(dataset => dataset.kind !== "checked");
  const [chosen, setChosen] = useState<string[]>(() => (callerwhale.selectedId && lists.some(item => item.id === callerwhale.selectedId) ? [callerwhale.selectedId] : []));
  const [summary, setSummary] = useState<CombineSummary | null>(null);
  const [compared, setCompared] = useState<string[]>([]);
  const [mode, setMode] = useState<CombineMode>("all");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<"compare" | "save" | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const watch = {
    onEvent: (event: Record<string, unknown>) => {
      if (typeof event.stage === "string") {
        const done =
          typeof event.completed === "number" && typeof event.total === "number" ? ` · ${formatNumber(event.completed)} of ${formatNumber(event.total)}` : "";
        setStage((STAGES[event.stage] ?? event.stage) + done);
      }
    },
  };
  const current = summary && compared.join() === chosen.join();

  async function compare(ids = chosen) {
    setBusy("compare");
    setError(null);
    setStage(STAGES.reading_lists);
    try {
      setSummary(await compareLists(ids, watch));
      setCompared(ids);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setBusy(null);
  }
  async function save() {
    setBusy("save");
    setError(null);
    setStage(STAGES.reading_lists);
    try {
      const made = await combineLists(chosen, mode, name.trim(), watch);
      await callerwhale.refresh();
      onDone(made.dataset_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(null);
    }
  }
  /** The person's own answer about two rows, then the comparison again with it. */
  async function decide(rows: LeadRow[], same: boolean) {
    setError(null);
    try {
      await overrule(rows[0].dataset_id, rows[0].row_number, rows[1].row_number, same, rows[1].dataset_id);
      await compare(compared);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const toggle = (id: string, on: boolean) => {
    setChosen(on ? [...chosen, id] : chosen.filter(item => item !== id));
    setMode("all");
  };
  const count = (value: CombineMode) =>
    !summary ? 0 : value.startsWith("only:") ? summary.counts.only[compared.indexOf(value.slice(5))] : summary.counts[value as "all" | "shared" | "in_all"];
  const nameOf = (id: string) => lists.find(item => item.id === id)?.name ?? "";
  const modes: { value: CombineMode; label: string }[] = summary
    ? [
        { value: "all", label: `Every lead, each once (${formatNumber(summary.counts.all)} rows)` },
        ...(compared.length > 2
          ? [{ value: "shared" as CombineMode, label: `Leads that are in more than one list (${formatNumber(summary.counts.shared)})` }]
          : []),
        { value: "in_all", label: `Leads that are in ${compared.length === 2 ? "both lists" : "every list"} (${formatNumber(summary.counts.in_all)})` },
        ...compared.map((id, at) => ({
          value: `only:${id}` as CombineMode,
          label: `Leads only “${nameOf(id)}” has (${formatNumber(summary.counts.only[at])})`,
        })),
      ]
    : [];

  const group = (item: { why: string; size: number; rows: LeadRow[] }, index: number, possible: boolean) => (
    <li key={index}>
      <p>
        <span className="muted">{item.why}</span>
      </p>
      <ul>
        {item.rows.map(row => (
          <li key={`${row.dataset_id}-${row.row_number}`}>
            <span className="num muted">
              {row.list} · row {row.row_number}
            </span>
            <span>{row.label || "No name, address or phone"}</span>
          </li>
        ))}
        {item.size > item.rows.length && <li className="muted">and {item.size - item.rows.length} more</li>}
      </ul>
      {item.rows.length >= 2 && (
        <div className="row">
          {possible && (
            <button type="button" className="link" disabled={busy !== null} onClick={() => void decide(item.rows, true)}>
              They are the same lead
            </button>
          )}
          <button type="button" className="link" disabled={busy !== null} onClick={() => void decide(item.rows, false)}>
            {possible ? "They are not" : `Not the same lead${item.size > 2 ? " (the first two)" : ""}`}
          </button>
        </div>
      )}
    </li>
  );

  return (
    <section className="list-view combine">
      <header className="list-head">
        <div>
          <h1>Combine lists</h1>
          <p>Pick the lists. Caller Whale compares their rows, whatever each list calls its columns, and makes one new list. The lists themselves stay as they are.</p>
        </div>
        <button type="button" className="button ghost" disabled={busy !== null} onClick={onCancel}>
          Close
        </button>
      </header>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <article className="card step">
        <header>
          <h2>Which lists?</h2>
          <span className="count">{chosen.length} chosen</span>
        </header>
        {lists.length < 2 ? (
          <p className="muted">This project has one list. Add another to combine them.</p>
        ) : (
          <div className="checks column">
            {lists.map(item => (
              <Check key={item.id} checked={chosen.includes(item.id)} onChange={on => toggle(item.id, on)}>
                {item.name} <span className="muted">· {formatNumber(item.row_count)} rows</span>
              </Check>
            ))}
          </div>
        )}
        <div className="row">
          <button type="button" className="button" disabled={chosen.length < 2 || busy !== null} onClick={() => void compare()}>
            {busy === "compare" ? "Comparing…" : current ? "Compare again" : "Compare them"}
          </button>
          {busy && (
            <span className="muted" role="status">
              {stage}
            </span>
          )}
        </div>
      </article>

      {summary && current && (
        <>
          <article className="card step">
            <header>
              <h2>What the lists share</h2>
              <span className="count">{formatNumber(summary.compared_pairs)} pairs of rows compared</span>
            </header>
            <p className="results-headline">
              <strong>
                {formatNumber(summary.rows_in)} rows are {formatNumber(summary.counts.all)} leads.
              </strong>{" "}
              {summary.counts.shared
                ? `${formatNumber(summary.counts.shared)} ${summary.counts.shared === 1 ? "lead is" : "leads are"} in more than one list.`
                : "No lead is in more than one list."}
              {summary.repeats_within > 0 &&
                ` ${formatNumber(summary.repeats_within)} ${summary.repeats_within === 1 ? "lead is" : "leads are"} written more than once inside one list.`}
            </p>
            <div className="table-wrap">
              <table className="compact">
                <thead>
                  <tr>
                    <th scope="col">List</th>
                    <th scope="col" className="num">
                      Rows
                    </th>
                    <th scope="col" className="num">
                      Leads
                    </th>
                    <th scope="col" className="num">
                      Only here
                    </th>
                    <th scope="col" className="num">
                      Also in another list
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.lists.map(item => (
                    <tr key={item.dataset_id}>
                      <th scope="row">{item.name}</th>
                      <td className="num">{formatNumber(item.rows)}</td>
                      <td className="num">{formatNumber(item.leads)}</td>
                      <td className="num">{formatNumber(item.only_here)}</td>
                      <td className="num">{formatNumber(item.elsewhere)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.examples.length > 0 && (
              <details className="step skiptrace-optional">
                <summary>
                  {summary.counts.shared > summary.examples.length
                    ? `The first ${summary.examples.length} of ${formatNumber(summary.counts.shared)} leads found in more than one list`
                    : "The leads found in more than one list"}
                </summary>
                <ul className="duplicate-groups">{summary.examples.map((item, index) => group(item, index, false))}</ul>
              </details>
            )}
            {summary.possible.length > 0 && (
              <details className="step skiptrace-optional" open>
                <summary>
                  {formatNumber(summary.possible_pairs)} {summary.possible_pairs === 1 ? "pair" : "pairs"} that might be the same lead, kept as two rows unless
                  you say so
                </summary>
                <ul className="duplicate-groups">{summary.possible.map((item, index) => group(item, index, true))}</ul>
              </details>
            )}
            {summary.owner_differs > 0 && (
              <details className="step skiptrace-optional">
                <summary>
                  {formatNumber(summary.owner_differs)} {summary.owner_differs === 1 ? "property has" : "properties have"} another owner in another list: sold
                  since, or one of the lists is wrong
                </summary>
                <ul className="duplicate-groups">
                  {summary.owner_differs_examples.map((item, index) => (
                    <li key={index}>
                      <ul>
                        {item.rows.map(row => (
                          <li key={`${row.dataset_id}-${row.row_number}`}>
                            <span className="num muted">
                              {row.list} · row {row.row_number}
                            </span>
                            <span>{row.label}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {summary.overruled > 0 && (
              <p className="muted">
                {formatNumber(summary.overruled)} of your own {summary.overruled === 1 ? "answer was" : "answers were"} followed here.
              </p>
            )}
          </article>

          <article className="card step">
            <header>
              <h2>Make the combined list</h2>
            </header>
            <div className="fields">
              <Field label="What it holds" value={mode} options={modes} onChange={value => setMode((value as CombineMode) ?? "all")} />
              <label className="field">
                <span>Name of the new list</span>
                <input
                  className="input"
                  value={name}
                  disabled={busy !== null}
                  placeholder={compared.map(nameOf).join(" + ")}
                  onChange={event => setName(event.target.value)}
                />
              </label>
            </div>
            <p className="muted">
              Each lead is one row: the row with the best number to call, or the most complete one, with what the other lists have for it filled in where it is
              empty. Phones and emails the other rows add go in Other phones and Other emails, and In lists and Combined from say where each row came from.
            </p>
            <div className="row">
              <button type="button" className="button" disabled={busy !== null || !count(mode)} onClick={() => void save()}>
                {busy === "save" ? "Saving…" : `Save ${formatNumber(count(mode))} rows as a new list`}
              </button>
            </div>
          </article>
        </>
      )}
    </section>
  );
}
