import { useEffect, useMemo, useRef, useState } from "react";
import { allRows } from "./service";
import type { Dataset, DatasetRow } from "./types";

/** State kept in this browser only. Reads and writes are guarded: storage can be blocked. */
export function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved ? (JSON.parse(saved) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Not saved; the page still works for this visit.
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** A list shows the marks of its checked copy when it has one. */
export function marksSource(dataset: Dataset, datasets: Dataset[]) {
  if (dataset.kind === "checked") return dataset;
  return datasets.filter(other => other.kind === "checked" && other.parent_dataset_id === dataset.id).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0] ?? dataset;
}

// A list's rows never change once it exists (an import is immutable, and each phone check saves a new list),
// so they are read from the service once and kept for as long as the project stays open.
type Entry = { rows?: DatasetRow[]; promise: Promise<DatasetRow[]> };
const rowsCache = new Map<string, Entry>();

export function clearRowsCache() {
  rowsCache.clear();
}

function loadRows(datasetId: string): Entry {
  let entry = rowsCache.get(datasetId);
  if (!entry) {
    const created: Entry = {
      promise: allRows(datasetId).then(
        rows => (created.rows = rows),
        reason => {
          // A failed read is not remembered, so the next look tries again.
          if (rowsCache.get(datasetId) === created) rowsCache.delete(datasetId);
          throw reason;
        },
      ),
    };
    rowsCache.set(datasetId, created);
    entry = created;
  }
  return entry;
}

/** Reads lists ahead of need, one after another, so the first look at each is immediate. Failures wait for the real look. */
export async function preloadRows(datasetIds: string[]) {
  for (const id of datasetIds) await loadRows(id).promise.catch(() => undefined);
}

/** One list's rows: at once when they were read before, otherwise `null` until they arrive. */
export function useRows(datasetId: string | null, onError: (reason: unknown) => void) {
  const [, redraw] = useState(0);
  const rows = datasetId ? rowsCache.get(datasetId)?.rows : undefined;
  useEffect(() => {
    if (!datasetId || rows) return;
    let current = true;
    loadRows(datasetId).promise.then(() => current && redraw(count => count + 1), reason => current && onError(reason));
    return () => { current = false; };
  }, [datasetId, rows, onError]);
  return rows ?? null;
}

/** Several lists' rows by list id, or `null` until every one has arrived. */
export function useAllRows(datasets: Dataset[], onError: (reason: unknown) => void) {
  const [arrived, redraw] = useState(0);
  const ready = datasets.every(dataset => rowsCache.get(dataset.id)?.rows);
  useEffect(() => {
    if (ready) return;
    let current = true;
    Promise.all(datasets.map(dataset => loadRows(dataset.id).promise)).then(() => current && redraw(count => count + 1), reason => current && onError(reason));
    return () => { current = false; };
  }, [datasets, ready, onError]);
  return useMemo(
    () => (ready ? Object.fromEntries(datasets.map(dataset => [dataset.id, rowsCache.get(dataset.id)!.rows!])) : null),
    // `arrived` changes when the last list lands, which is when `ready` flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [datasets, ready, arrived],
  );
}

/** The ids looked at most recently, newest last, so their screens can stay alive behind the one in view. */
export function useVisited(currentId: string | null, existing: string[], limit = 5) {
  const visited = useRef<string[]>([]);
  if (currentId) visited.current = [...visited.current.filter(id => id !== currentId), currentId].slice(-limit);
  return visited.current.filter(id => existing.includes(id));
}
