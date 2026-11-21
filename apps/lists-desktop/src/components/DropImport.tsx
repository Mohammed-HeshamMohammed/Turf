import { useCallback, useEffect, useRef, useState } from "react";
import { formatNumber } from "../lib/marks";
import { AlreadyHere, describeLeftOut, describeOverlaps, importContent, importFile, inDesktop, type Imported, type Project } from "../lib/service";
import { Icon } from "./Icon";

const TYPES = ["csv", "tsv", "txt", "xlsx", "json", "jsonl", "ndjson", "xml", "parquet", "docx", "zip", "gz"];

/** Something dropped on the window: its name, and how to add it (again, when the person asks, though it is here). */
type Dropped = { name: string; add: (allowDuplicate: boolean) => Promise<Imported> };
type Outcome = { key: number; name: string; state: "adding" | "added" | "already" | "failed"; text: string; again?: () => void };

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/**
 * Dropping a list's file anywhere on the window adds it to the project. While a file is held over the window the
 * whole window says so; afterwards each file's outcome is listed: added, already in the project (and then not added
 * again, unless the person asks), or why it could not be read.
 */
export function DropImport({ project, onAdded }: { project: Project | null; onAdded: (datasetId: string) => Promise<void> }) {
  const [over, setOver] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const next = useRef(0);
  const ready = useRef({ project, onAdded });
  ready.current = { project, onAdded };

  const set = (key: number, change: Partial<Outcome>) => setOutcomes(current => current.map(item => (item.key === key ? { ...item, ...change } : item)));

  const addOne = useCallback(async (file: Dropped, key: number, allowDuplicate: boolean): Promise<string | null> => {
    set(key, { state: "adding", text: "Adding…", again: undefined });
    try {
      const imported = await file.add(allowDuplicate);
      const left = describeLeftOut(imported);
      const shares = describeOverlaps(imported);
      set(key, { state: "added", text: [`Added, ${formatNumber(imported.row_count)} rows.`, left && `Left out ${left}.`, shares].filter(Boolean).join(" ") });
      return imported.dataset_id;
    } catch (reason) {
      if (reason instanceof AlreadyHere) {
        set(key, {
          state: "already",
          text: reason.message,
          again: () => void addOne(file, key, true).then(id => (id ? ready.current.onAdded(id) : undefined)),
        });
      } else set(key, { state: "failed", text: reason instanceof Error ? reason.message : String(reason) });
      return null;
    }
  }, []);

  const add = useCallback(
    async (files: Dropped[]) => {
      if (!files.length) return;
      if (!ready.current.project) {
        setOutcomes([
          {
            key: next.current++,
            name: files.length === 1 ? files[0].name : `${files.length} files`,
            state: "failed",
            text: "Open or create a project first, then drop the file again.",
          },
        ]);
        return;
      }
      const keyed = files.map(file => ({ file, key: next.current++ }));
      setOutcomes(current => [
        ...current.filter(item => item.state !== "added"),
        ...keyed.map(({ file, key }) => ({ key, name: file.name, state: "adding" as const, text: "Waiting…" })),
      ]);
      let last: string | null = null;
      // One at a time: each is compared with the lists already here, the ones just added among them.
      for (const { file, key } of keyed) last = (await addOne(file, key, false)) ?? last;
      if (last) await ready.current.onAdded(last);
    },
    [addOne],
  );

  // The desktop window is told where the dropped files are; a browser tab is given the files themselves.
  useEffect(() => {
    if (inDesktop) {
      let stop: (() => void) | undefined;
      let gone = false;
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
        getCurrentWebview()
          .onDragDropEvent(event => {
            const payload = event.payload;
            if (payload.type === "enter" || payload.type === "over") setOver(true);
            else if (payload.type === "leave") setOver(false);
            else if (payload.type === "drop") {
              setOver(false);
              void add(payload.paths.map(path => ({ name: baseName(path), add: (allowDuplicate: boolean) => importFile(path, allowDuplicate) })));
            }
          })
          .then(unlisten => (gone ? unlisten() : (stop = unlisten))),
      );
      return () => {
        gone = true;
        stop?.();
      };
    }
    const files = (event: DragEvent) => Boolean(event.dataTransfer?.types.includes("Files"));
    const enter = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      setOver(true);
    };
    const leave = (event: DragEvent) => {
      // Leaving the window itself, not passing from one thing in it to another.
      if (!event.relatedTarget) setOver(false);
    };
    const drop = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      setOver(false);
      void add(
        [...(event.dataTransfer?.files ?? [])].map(file => ({ name: file.name, add: (allowDuplicate: boolean) => importContent(file, allowDuplicate) })),
      );
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [add]);

  return (
    <>
      {over && (
        <div className="drop-over" role="status">
          <div>
            <Icon name="layers" size={36} />
            <strong>{project ? `Drop to add to ${project.name}` : "Open a project first"}</strong>
            <span>
              {project
                ? `Lists as ${TYPES.slice(0, 4).join(", ")} and more. A list that is already here is not added twice, whatever its file is called.`
                : "A list is added to the project that is open."}
            </span>
          </div>
        </div>
      )}
      {outcomes.length > 0 && (
        <aside className="card drop-outcomes" aria-label="Files added by dropping">
          <header>
            <h2>Dropped {outcomes.length === 1 ? "file" : "files"}</h2>
            <button type="button" className="button ghost small" onClick={() => setOutcomes([])}>
              Dismiss
            </button>
          </header>
          <ul>
            {outcomes.map(item => (
              <li key={item.key} className={item.state}>
                <strong>{item.name}</strong>
                <span role={item.state === "failed" ? "alert" : "status"}>{item.text}</span>
                {item.again && (
                  <button type="button" className="link" onClick={item.again}>
                    Add it all the same
                  </button>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </>
  );
}
