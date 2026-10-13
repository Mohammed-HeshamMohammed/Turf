import { useEffect, useState } from "react";
import type { Turf } from "../App";
import { formatDate, formatNumber } from "../lib/marks";
import {
  dueCallbacks,
  exportList,
  purgeDatasets,
  restoreDataset,
  saveFilter,
  savedFilters,
  STAGE_LABELS,
  trashedDatasets,
  type Due,
  type ExportKind,
  type SavedFilter,
  type Trashed,
} from "../lib/service";
import { Check } from "./Bits";
import { Icon } from "./Icon";
import { Select } from "./Select";

const leftOut = (left: Record<string, number>, words: Record<string, string>) =>
  Object.entries(left)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${formatNumber(count)} ${words[key] ?? key}`)
    .join(", ");

/** The files a list can be handed on as: the leads to call, for a dialer, and the addresses to mail. */
export function ListExports({ datasetId, checked, fail }: { datasetId: string; checked: boolean; fail: (reason: unknown) => void }) {
  const [open, setOpen] = useState<ExportKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [everyStage, setEveryStage] = useState(false);
  const [absentee, setAbsentee] = useState(false);
  const [noPhone, setNoPhone] = useState(false);
  const [noBoxes, setNoBoxes] = useState(false);
  async function make(kind: ExportKind) {
    setBusy(true);
    setMessage("");
    try {
      const made = await exportList(
        kind,
        datasetId,
        kind === "calls" ? { skip_stages: everyStage ? [] : undefined } : { absentee_only: absentee, no_phone_only: noPhone, skip_po_boxes: noBoxes },
      );
      if (made) {
        const left =
          kind === "calls"
            ? leftOut(made.left_out, { no_number: "with no number to call", repeats: "repeating another lead", stage: "not interested or dead" })
            : leftOut(made.left_out, { no_address: "with no address", repeats: "for an owner already in it", not_wanted: "outside your choice" });
        setMessage(`${made.filename}: ${formatNumber(made.rows)} ${made.rows === 1 ? "row" : "rows"}${left ? `. Left out: ${left}` : ""}.`);
        setOpen(null);
      }
    } catch (reason) {
      fail(reason);
    }
    setBusy(false);
  }
  return (
    <div className="download-actions">
      <div className="row">
        <button
          type="button"
          className="button ghost small"
          aria-expanded={open === "calls"}
          disabled={!checked}
          title={checked ? undefined : "Check the list's phones first"}
          onClick={() => setOpen(open === "calls" ? null : "calls")}
        >
          Call list
        </button>
        <button type="button" className="button ghost small" aria-expanded={open === "mail"} onClick={() => setOpen(open === "mail" ? null : "mail")}>
          Mail list
        </button>
      </div>
      {open === "calls" && (
        <div className="export-options">
          <p className="muted">
            A CSV for a dialer: each lead once, its best number first and its other usable numbers beside it, with its stage, callback and latest note. Rows
            with no number to call are left out.
          </p>
          <Check checked={everyStage} onChange={setEveryStage}>
            Include leads marked not interested or dead
          </Check>
          <button type="button" className="button small" disabled={busy} onClick={() => void make("calls")}>
            {busy ? "Making it…" : "Save the call list"}
          </button>
        </div>
      )}
      {open === "mail" && (
        <div className="export-options">
          <p className="muted">A CSV for letters: each owner once, at where their mail goes, with the property it is about.</p>
          <div className="checks">
            <Check checked={absentee} onChange={setAbsentee}>
              Only owners whose mail goes somewhere else
            </Check>
            <Check checked={noPhone} onChange={setNoPhone}>
              Only rows with no phone
            </Check>
            <Check checked={noBoxes} onChange={setNoBoxes}>
              Leave out PO boxes
            </Check>
          </div>
          <button type="button" className="button small" disabled={busy} onClick={() => void make("mail")}>
            {busy ? "Making it…" : "Save the mail list"}
          </button>
        </div>
      )}
      {message && (
        <span className="muted" role="status">
          {message}
        </span>
      )}
    </div>
  );
}

/** Lists the person deleted, for the thirty days they can still be put back. */
export function DeletedLists({ turf }: { turf: Turf }) {
  const [lists, setLists] = useState<Trashed[]>([]);
  useEffect(() => {
    let live = true;
    trashedDatasets().then(
      found => live && setLists(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [turf.version, turf.projectId]);
  if (!lists.length) return null;
  const after = (action: Promise<unknown>) => void action.then(() => turf.refresh(), turf.fail);
  return (
    <details className="deleted-lists">
      <summary>Deleted lists ({lists.length})</summary>
      <ul>
        {lists.map(item => (
          <li key={item.id}>
            <strong title={item.name}>{item.name}</strong>
            <span className="muted">
              {formatNumber(item.row_count)} rows · kept until {formatDate(item.kept_until)}
            </span>
            <span className="row">
              <button type="button" className="link" onClick={() => after(restoreDataset(item.id))}>
                Put it back
              </button>
              <button type="button" className="link" onClick={() => after(purgeDatasets(item.id))}>
                Delete for good
              </button>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Filters kept by name for a list: choosing one sets the filter bar, and the bar as it stands can be kept. */
export function SavedFilters({
  datasetId,
  current,
  filtering,
  onApply,
  fail,
}: {
  datasetId: string;
  current: SavedFilter["filter"];
  filtering: boolean;
  onApply: (filter: SavedFilter["filter"]) => void;
  fail: (reason: unknown) => void;
}) {
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState("");
  useEffect(() => {
    let live = true;
    savedFilters(datasetId).then(
      found => live && setSaved(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [datasetId]);
  if (!saved.length && !filtering) return null;
  return (
    <>
      {saved.length > 0 && (
        <Select
          variant="pill"
          icon="sliders"
          label="Saved filters"
          value={chosen}
          onChange={value => {
            setChosen(value);
            const found = saved.find(item => item.name === value);
            if (found) onApply(found.filter);
          }}
          options={[{ value: "", label: "Saved filters" }, ...saved.map(item => ({ value: item.name, label: item.name }))]}
        />
      )}
      {chosen && (
        <button
          type="button"
          className="chip"
          title="Remove this saved filter"
          onClick={() =>
            void saveFilter(datasetId, chosen, null).then(found => {
              setSaved(found);
              setChosen("");
            }, fail)
          }
        >
          Forget “{chosen}”
          <Icon name="close" size={14} />
        </button>
      )}
      {filtering &&
        (naming ? (
          <form
            className="row nowrap"
            onSubmit={event => {
              event.preventDefault();
              void saveFilter(datasetId, name, current).then(found => {
                setSaved(found);
                setChosen(found.find(item => item.name.toLowerCase() === name.trim().toLowerCase())?.name ?? "");
                setNaming(false);
                setName("");
              }, fail);
            }}
          >
            <input
              className="text"
              autoFocus
              value={name}
              placeholder="Name this filter"
              aria-label="Name for this filter"
              onChange={event => setName(event.target.value)}
            />
            <button type="submit" className="button small" disabled={!name.trim()}>
              Keep
            </button>
          </form>
        ) : (
          <button type="button" className="chip" onClick={() => setNaming(true)}>
            Keep this filter
          </button>
        ))}
    </>
  );
}

/** On the Dashboard: the leads to call back today or before, and the ones coming up. */
export function CallbacksCard({ turf }: { turf: Turf }) {
  const [found, setFound] = useState<Due | null>(null);
  useEffect(() => {
    let live = true;
    dueCallbacks().then(
      value => live && setFound(value),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [turf.version, turf.projectId, turf.callTarget]);
  if (!found || (!found.due.length && !found.coming.length)) return null;
  const shown = found.due.length ? found.due : found.coming;
  return (
    <article className="card next-steps callbacks">
      <header>
        <h2>{found.due.length ? "Callbacks due" : "Callbacks coming up"}</h2>
        <span className="count">{found.due.length ? `${found.due.length} due · ${found.coming.length} later` : found.coming.length}</span>
      </header>
      <ul>
        {shown.slice(0, 4).map(item => (
          <li key={item.lead_key}>
            <div>
              <strong>{item.label || `Row ${item.row_number}`}</strong>
              <small>
                {item.on === found.today ? "Today" : formatDate(`${item.on}T12:00:00`)} · {STAGE_LABELS[item.stage]} · {item.list}
                {item.note ? ` · ${item.note}` : ""}
              </small>
            </div>
            <button
              type="button"
              className="round"
              aria-label={`Call ${item.label || `row ${item.row_number}`}`}
              onClick={() => turf.openCall(item.dataset_id, item.row_number)}
            >
              <Icon name="phone" />
            </button>
          </li>
        ))}
      </ul>
      {shown.length > 4 && <p className="muted">and {shown.length - 4} more, in Calls.</p>}
    </article>
  );
}
