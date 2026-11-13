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
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    leadSource
      .load(ask, params => dispatch({ type: "BROWSE_LEADS", ...params }))
      .then(page => live && setAnswer({ key, page, failed: false }))
      .catch(() => live && setAnswer({ key, page: null, failed: true }));
    return () => {
      live = false;
    };
  }, [enabled, key, version, dispatch]);
  const current = answer.key === key && answer.page ? answer.page : held?.page || null;
  // While the next page is on its way the previous one stays on screen, as it always did, instead of the table emptying.
  const page = current || answer.page;
  const failed = answer.key === key && answer.failed;
  return { ids: page?.ids || [], total: page?.total ?? null, waiting: enabled && !current && !failed, failed };
}
