import type { ManualMarks } from "../marks";
import type { AreaMapping, ManualMark } from "../types";
import { call, inDesktop, invokeHost } from "./transport";

type CallerWhaleState = { marks: ManualMarks; areas: Record<string, AreaMapping> };

// In the desktop window the Rust host owns the file. A browser tab has no host, so development there falls back to browser storage.
const KEY = "callerwhale.state";
function browserState(): CallerWhaleState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<CallerWhaleState> | null;
    return { marks: saved?.marks ?? {}, areas: saved?.areas ?? {} };
  } catch {
    return { marks: {}, areas: {} };
  }
}
function saveBrowserState(state: CallerWhaleState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not saved; it still holds for this visit.
  }
  return state;
}

export async function callerwhaleState(): Promise<CallerWhaleState> {
  return inDesktop ? invokeHost<CallerWhaleState>("callerwhale_state") : browserState();
}

export async function setMark(number: string, mark: ManualMark | null, until?: string | null): Promise<ManualMarks> {
  return call<ManualMarks>("marks.set", { number, mark, until });
}

export async function setAreaColumns(datasetId: string, mapping: AreaMapping): Promise<Record<string, AreaMapping>> {
  if (inDesktop) return invokeHost<Record<string, AreaMapping>>("callerwhale_set_area_columns", { datasetId, mapping });
  const state = browserState();
  state.areas[datasetId] = mapping;
  return saveBrowserState(state).areas;
}
