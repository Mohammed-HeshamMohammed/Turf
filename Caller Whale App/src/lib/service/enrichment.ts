import { call } from "./transport";
import { runJob } from "./jobs";

// Pictures: one written into a cell (saved in the project), and the free aerial view of a place.
export const embeddedPicture = (name: string) => call<{ data_url: string }>("images.embedded", { name });
export const aerialPicture = (lat: number, lon: number) =>
  call<{ data_url?: string; credit?: string; pending?: boolean; unavailable?: string }>("images.aerial", { lat, lon });

// The National Do Not Call Registry, from the person's own download; kept on this computer for every project.
export type RegistryStatus = { area_codes: { area_code: string; count: number; imported_at: string; file: string; age_days: number; out_of_date: boolean }[]; numbers: number; max_age_days: number };
export const dncRegistryStatus = () => call<RegistryStatus>("dnc_registry.status");
export const dncRegistryRemove = (area_code: string) => call<RegistryStatus>("dnc_registry.remove", { area_code });
export const dncRegistryImport = (path: string, onLines: (lines: number) => void) =>
  runJob<{ area_codes: string[]; numbers: number; lines: number; skipped_lines: number }>("dnc_registry.import", { path }, {
    onEvent: payload => { if (payload.stage === "reading_registry" && typeof payload.lines === "number") onLines(payload.lines); },
  });
export async function pickRegistryFile() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({
    multiple: false, directory: false, filters: [{ name: "Do Not Call Registry files", extensions: ["txt", "csv", "zip", "xml", "dat"] }],
  });
  return typeof selected === "string" ? selected : null;
}

// NANPA downloads stay on this computer and contribute to every project's phone checks.
export type BlocksStatus = { area_codes: number; assigned: number; oldest_days: number | null; files: string[] };
export const nanpaBlocksStatus = () => call<BlocksStatus>("nanpa_blocks.status");
export const nanpaBlocksImport = (path: string) => runJob<{ area_codes: number; assigned: number; free: number }>("nanpa_blocks.import", { path });
export async function pickNanpaFile() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({
    multiple: false, directory: false, filters: [{ name: "NANPA number blocks", extensions: ["txt", "csv", "zip", "tsv", "dat"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export type FloodZone =
  | { zone: string; risk: "high" | "low" | "unknown"; text: string; pending?: never; unavailable?: never }
  | { pending: true; unavailable?: never; zone?: never; risk?: never; text?: never }
  | { unavailable: string; pending?: never; zone?: never; risk?: never; text?: never };
export const floodZone = (lat: number, lon: number, again = false) => call<FloodZone>("flood.of", { lat, lon, again });

// Email addresses: a verdict for each, with the domain's mail check finishing in the background.
export type EmailVerdict = { verdict: "ok" | "role" | "invalid" | "typo" | "disposable" | "no_mail" | "pending" | "unknown"; why: string; suggestion?: string };
export const checkEmails = (addresses: string[]) => call<Record<string, EmailVerdict>>("emails.check", { addresses });

// The area around a property from the US Census: its tract (no key), and the tract's figures with the person's free key.
export type CensusArea = {
  tract?: { geoid: string; name: string }; needs_key?: boolean; pending?: boolean; unavailable?: string;
  figures?: { year: number; median_income: number | null; median_value: number | null; owner_occupied_share: number | null; vacant_share: number | null } | null;
};
export const censusArea = (lat: number, lon: number) => call<CensusArea>("area.of", { lat, lon });
export const setCensusKey = (key: string) => call<{ configured: boolean }>("area.set_key", { key });
