// The one place that pages of a big workspace's leads are asked for. Leads, the call queue and Source lists all page through the
// server the same way; this keeps what each ask found, so a page opened twice, or by two screens, is asked for once.
//
// An answer is "fresh" until the device's records change (a sync brought changes, the workspace switched). Then it is "stale": still shown
// at once while the page asks again quietly (stale-while-revalidate), so nothing blinks back to a loading state and only the difference
// is fetched. The leads themselves still live in one place, the store the engine fills; this holds only which ids answered which ask.

export type LeadAsk = { term?: string; stage?: string; project?: string; callable?: boolean; sort?: string; offset?: number; limit?: number; count?: boolean };
export type LeadPage = { ids: string[]; total: number | null };
type Ask = (_ask: LeadAsk) => Promise<LeadPage | undefined | null> | LeadPage | undefined | null;

const MAX_ENTRIES = 300;
const filterKey = (ask: LeadAsk) => [ask.term || "", ask.stage || "", ask.project || "", ask.callable ? "callable" : "", ask.sort || ""].join("|");
const pageKey = (ask: LeadAsk) => filterKey(ask) + "|" + (ask.offset || 0) + "|" + (ask.limit || 0);

export function createLeadSource() {
  let epoch = 0;
  const pages = new Map<string, { page: LeadPage; epoch: number }>();
  const totals = new Map<string, { total: number; epoch: number }>();
  const inFlight = new Map<string, Promise<LeadPage>>();
  const listeners = new Set<() => void>();
  // What hangs off a lead (its tasks, notes, calls, deals) is asked for when the lead is opened, once. Changes that follow arrive through sync
  // like any other, so it is only forgotten when the device's records are taken again from scratch.
  const details = new Map<string, Promise<void>>();
  const related = new Map<string, { id: string; name: string; kind: string }[]>();

  return {
    /** What was found for this ask, or null. `stale` means the records have changed since: show it, and ask again. */
    peek(ask: LeadAsk) {
      const entry = pages.get(pageKey(ask));
      if (!entry) return null;
      const known = totals.get(filterKey(ask));
      return { page: { ids: entry.page.ids, total: entry.page.total ?? known?.total ?? null }, stale: entry.epoch !== epoch };
    },

    /** The total already known for a search, so the next page need not count again. */
    knownTotal(ask: LeadAsk) {
      return totals.get(filterKey(ask))?.total ?? null;
    },

    /** Answers from what is held while it is fresh; otherwise asks once, however many screens want the same page at the same time. */
    load(ask: LeadAsk, fetchPage: Ask): Promise<LeadPage> {
      const key = pageKey(ask);
      const held = pages.get(key);
      if (held && held.epoch === epoch) return Promise.resolve(held.page);
      const running = inFlight.get(key);
      if (running) return running;
      const startedIn = epoch;
      const known = totals.get(filterKey(ask));
      const request = Promise.resolve(fetchPage({ ...ask, count: ask.count ?? (known == null || known.epoch !== epoch) }))
        .then(found => {
          if (!found) throw new Error("No answer");
          const total = found.total ?? known?.total ?? null;
          const page = { ids: found.ids, total };
          pages.delete(key);
          pages.set(key, { page, epoch: startedIn });
          if (total != null) totals.set(filterKey(ask), { total, epoch: startedIn });
          while (pages.size > MAX_ENTRIES) pages.delete(pages.keys().next().value as string);
          return page;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, request);
      return request;
    },

    /** Asks for a lead's details once; opening the same lead again, from any screen, answers at once. A failed ask is forgotten so the next try goes out. */
    loadDetails(id: string, fetchDetails: (_id: string) => Promise<unknown>): Promise<void> {
      const held = details.get(id);
      if (held) return held;
      const request = Promise.resolve(fetchDetails(id)).then(
        result => {
          if (Array.isArray(result)) related.set(id, result);
        },
        error => {
          details.delete(id);
          throw error;
        },
      );
      details.set(id, request);
      while (details.size > MAX_ENTRIES) details.delete(details.keys().next().value as string);
      while (related.size > MAX_ENTRIES) related.delete(related.keys().next().value as string);
      return request;
    },

    /** The co-owners its details named: other leads at the same property under another name. */
    relatedOf(id: string): { id: string; name: string; kind: string }[] {
      return related.get(id) || [];
    },

    /** One lead's details are no longer in the store (a fresh snapshot dropped it): the next ask goes out again. */
    forgetDetail(id: string) {
      details.delete(id);
    },

    /** The records were taken again from scratch: details held before are no longer in the store. */
    forgetDetails() {
      details.clear();
    },

    /** The device's records changed: everything held is now stale, and the screens showing it ask again. */
    invalidate() {
      epoch++;
      listeners.forEach(listener => listener());
    },

    /** The workspace changed (switch, sign out): nothing held belongs to the next one. */
    clear() {
      pages.clear();
      totals.clear();
      inFlight.clear();
      details.clear();
      epoch++;
      listeners.forEach(listener => listener());
    },

    version: () => epoch,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    size: () => pages.size,
    detailsHeld: () => details.size,
  };
}

export const leadSource = createLeadSource();
