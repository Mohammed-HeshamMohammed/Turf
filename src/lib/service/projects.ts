import { call } from "./transport";

/** What was taken out of one list because it held nothing. */
export type LeftOut = { name?: string; dropped_empty_rows?: number; dropped_empty_columns?: number };

export type Project = {
  id: string; name: string; root_path: string; created_at: string;
  /** Lists that lost empty rows or columns when the project was opened. */
  tidied?: LeftOut[];
};

/** "3 empty columns", "2 empty rows and 1 empty column", or nothing when nothing was left out. */
export function describeLeftOut({ dropped_empty_rows: rows = 0, dropped_empty_columns: columns = 0 }: LeftOut) {
  const count = (amount: number, word: string) => `${amount.toLocaleString("en-US")} empty ${word}${amount === 1 ? "" : "s"}`;
  return [rows && count(rows, "row"), columns && count(columns, "column")].filter(Boolean).join(" and ");
}

export const currentProject = () => call<Project | null>("project.current");
export const recentProjects = () => call<Project[]>("project.recent");
export const openProject = (path: string) => call<Project>("project.open", { path });
export const createProject = (path: string, name: string) => call<Project>("project.create", { path, name });

export async function pickFolder() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}
