import { useState } from "react";
import { describeLeftOut, importFile, inDesktop, pickImportFile } from "../lib/service";
import { KIND_LABELS, formatNumber } from "../lib/marks";
import type { Dataset } from "../lib/types";
import { SearchBox } from "./Bits";
import { useContextMenu, type MenuItem } from "./ContextMenu";

export function ListPicker({
  datasets,
  selectedId,
  onSelect,
  onImported,
  menuFor,
}: {
  datasets: Dataset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onImported: (datasetId: string) => Promise<void>;
  /** What right-clicking a list offers. */
  menuFor: (dataset: Dataset) => MenuItem[];
}) {
  const menu = useContextMenu();
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = datasets.filter(dataset => !needle || dataset.name.toLowerCase().includes(needle));

  async function bringIn(file: string | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const imported = await importFile(file);
      // An import leaves out what held nothing; say so, so the smaller counts are no surprise.
      const left = describeLeftOut(imported);
      if (left) setNote(`Left out ${left}.`);
      await onImported(imported.dataset_id);
      setTyping(false);
      setPath("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
    setBusy(false);
  }

  return (
    <aside className="card picker">
      <header>
        <h2>
          Lists <span className="count">{datasets.length}</span>
        </h2>
        {/* A browser tab cannot open a file dialog on the service's side, so the path is typed there. */}
        <button
          type="button"
          className="button ghost small"
          disabled={busy}
          onClick={() => (inDesktop ? void pickImportFile().then(bringIn) : setTyping(!typing))}
        >
          {busy ? "Importing…" : "Import"}
        </button>
      </header>
      {typing && (
        <form
          className="row nowrap"
          onSubmit={event => {
            event.preventDefault();
            void bringIn(path.trim() || null);
          }}
        >
          <input
            className="input grow"
            value={path}
            placeholder="Full path to a CSV, text or Excel file"
            aria-label="File to import"
            onChange={event => setPath(event.target.value)}
          />
          <button type="submit" className="button small" disabled={busy || !path.trim()}>
            Add
          </button>
        </form>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="notice good" role="status">
          {note}
        </p>
      )}
      <SearchBox value={query} onChange={setQuery} placeholder="Search lists" />
      <ul>
        {shown.map(dataset => (
          <li key={dataset.id}>
            <button
              type="button"
              title={dataset.name}
              aria-current={dataset.id === selectedId ? "true" : undefined}
              onClick={() => onSelect(dataset.id)}
              onContextMenu={event => menu(event, menuFor(dataset))}
            >
              <strong>{dataset.name}</strong>
              <span>
                {KIND_LABELS[dataset.kind]} · {formatNumber(dataset.row_count)} rows
              </span>
            </button>
          </li>
        ))}
      </ul>
      {!datasets.length && <p className="muted">This project has no lists yet. Import a file to start.</p>}
      {datasets.length > 0 && !shown.length && <p className="muted">No list has that name.</p>}
    </aside>
  );
}
