// Connected mode for the prototype: state built from the server's records with the person's pending changes replayed
// on top, and the actions that become API operations.

import { reducer } from "../model.js";
import { seedState } from "../data.js";
import { collectionsFromStore } from "./translate.js";

/** The prototype reducer, plus the actions that bring server state in. */
export function remoteReducer(state, action) {
  switch (action.type) {
    case "REMOTE_START":
      return {
        ...state,
        role: action.role,
        remote: action.remote,
        online: true,
        settings: { ...state.settings, workspace: action.remote.organization || state.settings.workspace },
        leads: [],
        tasks: [],
        deals: [],
        handoffs: [],
        threads: [],
        activities: [],
        datasets: [],
        queue: [],
        conflicts: [],
      };
    case "REMOTE_SYNC": {
      if (!state.remote) return state;
      // Server state first, then what this person changed and the server has not confirmed yet.
      let next = { ...state, ...action.collections, online: action.online };
      for (const pending of action.pending) next = reducer(next, pending);
      return { ...next, queue: action.queue, remoteStatus: action.status, remoteError: action.error };
    }
    case "REMOTE_END":
      return seedState();
    default:
      return reducer(state, action);
  }
}

/** The REMOTE_SYNC action for an engine snapshot. */
export function syncAction(snapshot, person) {
  const collections = snapshot.store ? { ...collectionsFromStore(snapshot.store), threads: [], activities: [] } : { leads: [], tasks: [], deals: [], handoffs: [] };
  return {
    type: "REMOTE_SYNC",
    collections,
    pending: snapshot.ops.filter(op => op.status === "Pending" && op.action).map(op => op.action),
    queue: snapshot.ops.map(op => ({
      id: op.id,
      leadId: op.payload.lead_id || op.payload.id || null,
      label: op.label || op.kind,
      kind: op.kind,
      actor: person,
      role: "",
      status: op.status,
      serverValue: op.message || "",
      fields: op.fields,
      at: op.claimed_at,
    })),
    online: snapshot.online,
    status: snapshot.status,
    error: snapshot.error,
  };
}

/** Actions that only change this device's view and never reach the server. */
export const LOCAL_ONLY = new Set(["PERSONAL", "MARK_READ", "SOURCE_MAPPING", "CHECK", "IMPORT", "SETTINGS", "INTEGRATION", "PERMISSION", "REPORT_SCHEDULE", "RULE", "NEW_THREAD"]);
