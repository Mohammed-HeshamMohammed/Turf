import { useEffect, useMemo, useRef, useState } from "react";
import { ownerColumns, ownerIndex } from "./owners";
import { photoIndex, type PhotoIndex } from "./photos";
import { allRows, skiptraceSuggest } from "./service";
import type { AreaMapping, Dataset, DatasetRow, SkiptraceSuggestion } from "./types";

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

/** The pictures of every property in the project's lists, by place, so a row without its own can borrow one. */
export function usePhotoIndex(datasets: Dataset[], areaMaps: Record<string, AreaMapping>, onError: (reason: unknown) => void): PhotoIndex {
  // Each list once, read where its marks are (a checked copy has the same rows and pictures as its list).
  const lists = useMemo(() => datasets.filter(dataset => !(dataset.kind === "checked" && datasets.some(other => other.id === dataset.parent_dataset_id)))
    .map(dataset => ({ dataset, source: marksSource(dataset, datasets) })), [datasets]);
  const sources = useMemo(() => lists.map(item => item.source), [lists]);
  const all = useAllRows(sources, onError);
  return useMemo(() => (all ? photoIndex(lists.map(({ dataset, source }) => {
    const rows = all[source.id] ?? [];
    return { rows, columns: rows[0] ? Object.keys(rows[0].raw) : [], saved: areaMaps[dataset.id] };
  })) : new Map()), [all, lists, areaMaps]);
}

/** Each list's own lists, once: a checked copy whose list is here is the same rows. */
export function primaryLists(datasets: Dataset[]) {
  return datasets.filter(dataset => !(dataset.kind === "checked" && datasets.some(other => other.id === dataset.parent_dataset_id)));
}

/** Each list's Skip Tracing setup (phone columns, owner columns, what its call statuses mean), read once and shared. */
export function useListSetups(datasets: Dataset[], version: number): Record<string, SkiptraceSuggestion | null> {
  const [setups, setSetups] = useState<Record<string, SkiptraceSuggestion | null>>({});
  const ids = primaryLists(datasets).map(dataset => dataset.id).join();
  useEffect(() => {
    let current = true;
    const lists = ids ? ids.split(",") : [];
    void Promise.all(lists.map(id => skiptraceSuggest(id).then(setup => [id, setup] as const, () => [id, null] as const)))
      .then(entries => { if (current) setSetups(Object.fromEntries(entries)); });
    return () => { current = false; };
  }, [ids, version]);
  return setups;
}

/** Owners and contacts of every list, by property and by mailing address, for finding the same owner elsewhere. */
export function useOwnerIndex(datasets: Dataset[], setups: Record<string, SkiptraceSuggestion | null>, areaMaps: Record<string, AreaMapping>, onError: (reason: unknown) => void) {
  const lists = useMemo(() => primaryLists(datasets).map(dataset => ({ dataset, source: marksSource(dataset, datasets) })), [datasets]);
  const sources = useMemo(() => lists.map(item => item.source), [lists]);
  const all = useAllRows(sources, onError);
  return useMemo(() => {
    if (!all) return null;
    const read = lists.map(({ dataset, source }) => {
      const rows = all[source.id] ?? [];
      return { dataset, rows, columns: ownerColumns(rows[0] ? Object.keys(rows[0].raw) : [], setups[dataset.id], areaMaps[dataset.id]) };
    });
    return { index: ownerIndex(read), lists: read };
  }, [all, lists, setups, areaMaps]);
}
