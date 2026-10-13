import type { Dataset, DatasetRow } from "../types";
import { call, inDesktop } from "./transport";
import { runJob } from "./jobs";

export const listDatasets = () => call<Dataset[]>("dataset.list");
export const importFile = (path: string) => runJob<{ dataset_id: string; row_count: number; dropped_empty_rows?: number; dropped_empty_columns?: number }>("dataset.import", { path });

export const renameDataset = (dataset_id: string, name: string) => call<{ dataset_id: string; name: string }>("dataset.rename", { dataset_id, name });
/** Removes the list and its rows from the project. Lists made from it stay. */
export const deleteDataset = (dataset_id: string) => call<{ deleted: string }>("dataset.delete", { dataset_id });

/** The service returns at most 5,000 rows a call. */
export const datasetRows = (dataset_id: string, offset: number, limit: number) => call<DatasetRow[]>("dataset.rows", { dataset_id, offset, limit });

const PAGE = 5000;

export async function allRows(dataset_id: string) {
  const rows: DatasetRow[] = [];
  for (;;) {
    const page = await datasetRows(dataset_id, rows.length, PAGE);
    // Ends on an empty page, not a short one, so it is right whatever page size the service allows.
    if (!page.length) return rows;
    rows.push(...page);
  }
}

/** Downloads a project archive; originals retain their exact bytes, checked copies include every column. */
export async function downloadDataset(datasetId: string, version: "original" | "checked", onProgress?: (percent: number) => void): Promise<boolean> {
  const payload = { dataset_id: datasetId, version };
  const info = await call<{ filename: string; size: number; mime: string; hash: string }>("dataset.download", payload);
  if (inDesktop) {
    const path = await (await import("@tauri-apps/plugin-dialog")).save({ defaultPath: info.filename });
    if (!path) return false;
    await call("dataset.download_save", { ...payload, path, hash: info.hash });
  } else {
    const parts: ArrayBuffer[] = [];
    let offset = 0;
    while (offset < info.size) {
      const chunk = await call<{ data: string }>("dataset.download_chunk", { ...payload, hash: info.hash, offset });
      const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0));
      if (!bytes.length || offset + bytes.length > info.size) throw new Error("The download was interrupted. Please try again.");
      parts.push(bytes.buffer);
      offset += bytes.length;
      onProgress?.(Math.round(offset / info.size * 100));
    }
    const url = URL.createObjectURL(new Blob(parts, { type: info.mime }));
    const link = document.createElement("a");
    link.href = url;
    link.download = info.filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}

export async function pickImportFile() {
  const selected = await (await import("@tauri-apps/plugin-dialog")).open({
    multiple: false, directory: false, filters: [{ name: "Lists", extensions: ["csv", "tsv", "txt", "xlsx", "json", "jsonl", "ndjson", "xml", "parquet", "docx", "zip", "gz"] }],
  });
  return typeof selected === "string" ? selected : null;
}
