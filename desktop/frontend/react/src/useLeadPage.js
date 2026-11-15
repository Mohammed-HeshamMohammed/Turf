import { useEffect, useState, useSyncExternalStore } from "react";
import { useCrm } from "./context.jsx";
import { leadSource } from "./lead-source.ts";

/**
 * One page of a big workspace's leads. A page held from before shows at once (and quietly refreshes if the records have changed since),
 * so `waiting` is only true the first time a page is asked for. `failed` means the server could not page: show what the device holds.
 */
export function useLeadPage(ask, enabled) {
  const { dispatch } = useCrm();
  const version = useSyncExternalStore(leadSource.subscribe, leadSource.version);
  const key = JSON.stringify(ask);
  const held = enabled ? leadSource.peek(ask) : null;
  const [answer, setAnswer] = useState({ key: "", page: null, failed: false });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    leadSource
      .load(ask, params => dispatch({ type: "BROWSE_LEADS", ...params }))
      .then(page => live && setAnswer({ key, page, failed: false }))
      .catch(() => live && setAnswer({ key, page: null, failed: true }))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [enabled, key, version, dispatch]);
  const current = answer.key === key && answer.page ? answer.page : held?.page || null;
  // While the next page is on its way the previous one stays on screen, as it always did, instead of the table emptying.
  const page = current || answer.page;
  const failed = answer.key === key && answer.failed;
  // `loading`: an answer (first or fresh) is on its way, for a spinner; the rows on screen stay until it lands.
  return { ids: page?.ids || [], total: page?.total ?? null, waiting: enabled && !current && !failed, failed, loading: enabled && loading };
}

/**
 * A lead's tasks, notes, calls and deals, when this device holds only a window of a big workspace and the lead is outside it: asked for once
 * when the lead is opened (and kept), then filled in on the page as they arrive. Does nothing where the device already holds everything.
 */
export function useLeadDetails(id, enabled, missing = false) {
  const { dispatch } = useCrm();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !id) return;
    let live = true;
    setLoading(true);
    // The lead itself is not on this device (a fresh snapshot or a reset dropped it while its page was open): ask again, and the
    // answer brings the lead back instead of the page saying it is outside the person's view.
    if (missing) leadSource.forgetDetail(id);
    leadSource
      .loadDetails(id, () => dispatch({ type: "LEAD_DETAILS", id }))
      .catch(() => {})
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [id, enabled, missing, dispatch]);
  return loading;
}
