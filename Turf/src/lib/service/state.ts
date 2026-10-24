import type { ManualMarks } from "../marks";
import type { AreaMapping, ManualMark } from "../types";
import { call, inDesktop, invokeHost } from "./transport";

type TurfState = { marks: ManualMarks; areas: Record<string, AreaMapping> };

// In the desktop window the Rust host owns the file. A browser tab has no host, so development there falls back to browser storage.
const KEY = "turf.state";
function browserState(): TurfState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TurfState> | null;
    return { marks: saved?.marks ?? {}, areas: saved?.areas ?? {} };
  } catch {
    return { marks: {}, areas: {} };
  }
}
function saveBrowserState(state: TurfState) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Not saved; it still holds for this visit.
  }
  return state;
}

export async function turfState(): Promise<TurfState> {
  return inDesktop ? invokeHost<TurfState>("turf_state") : browserState();
}

export async function setMark(number: string, mark: ManualMark | null, until?: string | null): Promise<ManualMarks> {
  return call<ManualMarks>("marks.set", { number, mark, until });
}

export async function setAreaColumns(datasetId: string, mapping: AreaMapping): Promise<Record<string, AreaMapping>> {
  if (inDesktop) return invokeHost<Record<string, AreaMapping>>("turf_set_area_columns", { datasetId, mapping });
  const state = browserState();
  state.areas[datasetId] = mapping;
  return saveBrowserState(state).areas;
}
