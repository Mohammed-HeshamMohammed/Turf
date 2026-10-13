import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addOwners, countOwners, emptyOwnerCounts, emptyOwnerIndex, ownerColumns, type OwnerCounts, type OwnerIndex, type OwnerList } from "./owners";
import { photoIndex, type PhotoIndex } from "./photos";
import { allRows, checkEmails, skiptraceSuggest, type EmailVerdict } from "./service";
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
  return (
    datasets
      .filter(other => other.kind === "checked" && other.parent_dataset_id === dataset.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))[0] ?? dataset
  );
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
    loadRows(datasetId).promise.then(
      () => current && redraw(count => count + 1),
      reason => current && onError(reason),
    );
    return () => {
      current = false;
    };
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
    Promise.all(datasets.map(dataset => loadRows(dataset.id).promise)).then(
      () => current && redraw(count => count + 1),
      reason => current && onError(reason),
    );
    return () => {
      current = false;
    };
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
  const lists = useMemo(() => primaryLists(datasets).map(dataset => ({ dataset, source: marksSource(dataset, datasets) })), [datasets]);
  const sources = useMemo(() => lists.map(item => item.source), [lists]);
  const all = useAllRows(sources, onError);
  return useMemo(
    () =>
      all
        ? photoIndex(
            lists.map(({ dataset, source }) => {
              const rows = all[source.id] ?? [];
              return { rows, columns: rows[0] ? Object.keys(rows[0].raw) : [], saved: areaMaps[dataset.id] };
            }),
          )
        : new Map(),
    [all, lists, areaMaps],
  );
}

/** Each list's own lists, once: a checked copy whose list is here is the same rows. */
export function primaryLists(datasets: Dataset[]) {
  return datasets.filter(dataset => !(dataset.kind === "checked" && datasets.some(other => other.id === dataset.parent_dataset_id)));
}

/** Each list's Skip Tracing setup (phone columns, owner columns, what its call statuses mean), read once and shared. */
export function useListSetups(datasets: Dataset[], version: number): Record<string, SkiptraceSuggestion | null> {
  const [setups, setSetups] = useState<Record<string, SkiptraceSuggestion | null>>({});
  const ids = primaryLists(datasets)
    .map(dataset => dataset.id)
    .join();
  useEffect(() => {
    let current = true;
    const lists = ids ? ids.split(",") : [];
    void Promise.all(
      lists.map(id =>
        skiptraceSuggest(id).then(
          setup => [id, setup] as const,
          () => [id, null] as const,
        ),
      ),
    ).then(entries => {
      if (current) setSetups(Object.fromEntries(entries));
    });
    return () => {
      current = false;
    };
  }, [ids, version]);
  return setups;
}

// Reading every row of a long list at once holds the window still for seconds. Past this many rows the work is done
// in turns of this size, and the window draws and answers in between.
const TURN = 5000;
// A message to ourselves, not a timer: a window that is minimised or behind another slows its timers to one a second.
const nextTurn = () =>
  new Promise<void>(resolve => {
    if (typeof MessageChannel === "undefined") return void setTimeout(resolve);
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

/**
 * Something built from the rows of some lists: at once when there are few rows, otherwise in turns, `null` until it is
 * done. While a long one is being built again (a setup changed, say) the earlier one stays, so nothing blinks.
 * `start` and `add` must keep their identity between draws.
 */
function useInTurns<T>(lists: OwnerList[] | null, start: () => T, add: (value: T, list: OwnerList, from: number, to: number) => void): T | null {
  const few = (lists?.reduce((sum, list) => sum + list.rows.length, 0) ?? 0) <= TURN;
  const quick = useMemo(() => {
    if (!lists || !few) return null;
    const value = start();
    for (const list of lists) add(value, list, 0, list.rows.length);
    return value;
  }, [lists, few, start, add]);
  const [slow, setSlow] = useState<{ ids: string; value: T } | null>(null);
  const ids = lists?.map(list => list.dataset.id).join() ?? "";
  useEffect(() => {
    if (!lists || few) return;
    let current = true;
    void (async () => {
      const value = start();
      for (const list of lists) {
        for (let from = 0; from < list.rows.length; from += TURN) {
          add(value, list, from, from + TURN);
          await nextTurn();
          if (!current) return;
        }
      }
      setSlow({ ids: lists.map(list => list.dataset.id).join(), value });
    })();
    return () => {
      current = false;
    };
  }, [lists, few, start, add]);
  if (!lists) return null;
  return few ? quick : slow?.ids === ids ? slow.value : null;
}

/** Owners and contacts of every list, by property and by mailing address, for finding the same owner elsewhere. */
export function useOwnerIndex(
  datasets: Dataset[],
  setups: Record<string, SkiptraceSuggestion | null>,
  areaMaps: Record<string, AreaMapping>,
  onError: (reason: unknown) => void,
) {
  const lists = useMemo(() => primaryLists(datasets).map(dataset => ({ dataset, source: marksSource(dataset, datasets) })), [datasets]);
  const sources = useMemo(() => lists.map(item => item.source), [lists]);
  const all = useAllRows(sources, onError);
  const read = useMemo<OwnerList[] | null>(
    () =>
      all
        ? lists.map(({ dataset, source }) => {
            const rows = all[source.id] ?? [];
            return { dataset, rows, columns: ownerColumns(rows[0] ? Object.keys(rows[0].raw) : [], setups[dataset.id], areaMaps[dataset.id]) };
          })
        : null,
    [all, lists, setups, areaMaps],
  );
  const index = useInTurns(read, emptyOwnerIndex, addOwners);
  return useMemo(() => (read && index ? { index, lists: read } : null), [read, index]);
}

/** What the owners of every list show, counted: `null` until the owners are read and counted. */
export function useOwnerStats(owners: { index: OwnerIndex; lists: OwnerList[] } | null, emailOk: (email: string) => boolean): OwnerCounts | null {
  const index = owners?.index;
  const add = useCallback(
    (counts: OwnerCounts, list: OwnerList, from: number, to: number) => {
      if (index) countOwners(counts, list, index, emailOk, from, to);
    },
    [index, emailOk],
  );
  return useInTurns(owners?.lists ?? null, emptyOwnerCounts, add);
}

/** A verdict for each email address, asked again while domains are still being looked up. */
export function useEmailVerdicts(addresses: string[]): Map<string, EmailVerdict> {
  const [verdicts, setVerdicts] = useState<Map<string, EmailVerdict>>(new Map());
  const key = [...new Set(addresses)].sort().join("\n");
  useEffect(() => {
    if (!key) {
      setVerdicts(new Map());
      return;
    }
    let current = true;
    let timer = 0;
    let tries = 0;
    const list = key.split("\n");
    const ask = async () => {
      const found = new Map<string, EmailVerdict>();
      for (let start = 0; start < list.length; start += 20_000) {
        Object.entries(await checkEmails(list.slice(start, start + 20_000))).forEach(([address, verdict]) => found.set(address, verdict));
      }
      if (!current) return;
      // The same answers as last time are not a change: everything counted from them would be counted again.
      setVerdicts(previous =>
        previous.size === found.size && [...found].every(([address, item]) => previous.get(address)?.verdict === item.verdict) ? previous : found,
      );
      if ([...found.values()].some(item => item.verdict === "pending") && tries++ < 40)
        timer = window.setTimeout(() => void ask().catch(() => undefined), 2500);
    };
    void ask().catch(() => undefined);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [key]);
  return verdicts;
}

/** Whether an email can be used to reach someone: not invalid, a typo, a throwaway, or a domain without mail. */
export const usableEmail = (verdicts: Map<string, EmailVerdict>, address: string) =>
  !["invalid", "typo", "disposable", "no_mail"].includes(verdicts.get(address)?.verdict ?? "ok");
