import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppMenu, type MenuAction } from "./components/AppMenu";
import { ContextMenuProvider } from "./components/ContextMenu";
import { DropImport } from "./components/DropImport";
import { ProjectGate } from "./components/ProjectGate";
import { TitleBar } from "./components/TitleBar";
import {
  backupProject,
  clearSuggestions,
  currentProject,
  describeLeftOut,
  importFile,
  inDesktop,
  listDatasets,
  openProject,
  pickImportFile,
  setAreaColumns,
  setMark,
  skiptraceSuggest,
  turfState,
  projectMarks,
  importLegacyMarks,
  type Project,
} from "./lib/service";
import { clearRowsCache, isLarge, marksSource, preloadRows, useStored } from "./lib/hooks";
import type { ManualMarks } from "./lib/marks";
import type { AreaMapping, Dataset, ManualMark } from "./lib/types";
import { Dashboard } from "./tabs/Dashboard";
import { Lists } from "./tabs/Lists";
import { Calls } from "./tabs/Calls";
import { SkipTracing } from "./tabs/SkipTracing";

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "lists", label: "Lists" },
  { id: "skiptracing", label: "Skip Tracing" },
  { id: "calls", label: "Calls" },
] as const;

export type TabId = (typeof TABS)[number]["id"];

export type Turf = {
  projectId: string;
  legacyManual: ManualMarks;
  importLegacy: () => Promise<void>;
  datasets: Dataset[];
  /** Bumped when the lists change, so views reload their rows. */
  version: number;
  refresh: () => Promise<void>;
  selectedId: string | null;
  select: (id: string) => void;
  open: (tab: TabId, id?: string) => void;
  manual: ManualMarks;
  setMark: (number: string, mark: ManualMark | null, until?: string | null) => void;
  areaMaps: Record<string, AreaMapping>;
  setAreaMap: (datasetId: string, mapping: AreaMapping) => void;
  fail: (reason: unknown) => void;
  /** A lead to go straight to in Calls: a callback opened from the Dashboard. */
  callTarget: { datasetId: string; rowNumber: number } | null;
  openCall: (datasetId: string, rowNumber: number) => void;
  clearCallTarget: () => void;
};

export function App() {
  const [tab, setStoredTab] = useStored<TabId>("turf.tab", "dashboard");
  // A tab stays alive once it has been opened, so coming back to it shows what was there, where it was scrolled to.
  const [openedTabs, setOpenedTabs] = useState<TabId[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolls = useRef<Partial<Record<TabId, number>>>({});
  const setTab = useCallback(
    (next: TabId) => {
      setStoredTab(current => {
        if (scroller.current) scrolls.current[current] = scroller.current.scrollTop;
        return next;
      });
    },
    [setStoredTab],
  );
  useLayoutEffect(() => {
    setOpenedTabs(current => (current.includes(tab) ? current : [...current, tab]));
    if (scroller.current) scroller.current.scrollTop = scrolls.current[tab] ?? 0;
  }, [tab]);
  // undefined: not asked yet. null: the service has no project open.
  const [project, setProject] = useState<Project | null | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [callTarget, setCallTarget] = useState<Turf["callTarget"]>(null);
  const [manual, setManual] = useState<ManualMarks>({});
  const [legacyManual, setLegacyManual] = useState<ManualMarks>({});
  const [areaMaps, setAreaMaps] = useState<Record<string, AreaMapping>>({});
  const [error, setError] = useState<string | null>(null);
  // Something the app did by itself that the person should know about, such as leaving out empty columns.
  const [note, setNote] = useState<string | null>(null);
  const noteTidied = useCallback((opened: Project | null) => {
    const lines = (opened?.tidied ?? []).map(item => `${describeLeftOut(item)} from ${item.name}`);
    setNote(lines.length ? `Removed ${lines.join("; ")}. Nothing that held data was touched.` : null);
  }, []);

  const fail = useCallback((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)), []);

  const refresh = useCallback(async () => {
    setDatasets(await listDatasets());
    setVersion(current => current + 1);
  }, []);

  const start = useCallback(async () => {
    setError(null);
    try {
      const saved = await turfState();
      setLegacyManual(saved.marks);
      setAreaMaps(saved.areas);
      const open = await currentProject();
      setProject(open);
      noteTidied(open);
      if (open) {
        setManual(await projectMarks());
        await refresh();
      }
    } catch (reason) {
      fail(reason);
    }
  }, [refresh, fail, noteTidied]);

  useEffect(() => {
    void start();
  }, [start]);

  const opened = useCallback(
    (next: Project) => {
      clearRowsCache();
      clearSuggestions();
      scrolls.current = {};
      setOpenedTabs([]);
      setProject(next);
      noteTidied(next);
      setChoosing(false);
      setDatasets(null);
      setManual({});
      setSelectedId(null);
      projectMarks().then(setManual, fail);
      refresh().catch(fail);
    },
    [refresh, fail, noteTidied],
  );

  const turf = useMemo<Turf | null>(
    () =>
      datasets && {
        projectId: project?.id ?? "",
        legacyManual,
        importLegacy: async () => {
          setManual(await importLegacyMarks(legacyManual));
        },
        datasets,
        version,
        refresh,
        // A list that is gone (deleted, or another project) is not kept selected.
        selectedId: datasets.some(dataset => dataset.id === selectedId) ? selectedId : (datasets[0]?.id ?? null),
        select: setSelectedId,
        open: (next, id) => {
          if (id) setSelectedId(id);
          setTab(next);
        },
        manual,
        // Saved in the project; a failed write never looks saved.
        setMark: (number, mark, until) => void setMark(number, mark, until).then(setManual, fail),
        areaMaps,
        setAreaMap: (datasetId, mapping) => void setAreaColumns(datasetId, mapping).then(setAreaMaps, fail),
        fail,
        callTarget,
        openCall: (datasetId, rowNumber) => {
          setSelectedId(datasetId);
          setCallTarget({ datasetId, rowNumber });
          setTab("calls");
        },
        clearCallTarget: () => setCallTarget(null),
      },
    [datasets, version, refresh, selectedId, manual, legacyManual, project, areaMaps, setTab, fail, callTarget],
  );

  // Read ahead in the background: every list's rows (the dashboard needs them all anyway), and the Skip Tracing
  // setup of the list in view. Switching tabs or lists then has nothing to wait for.
  useEffect(() => {
    if (!datasets) return;
    const primary = datasets.filter(dataset => !(dataset.kind === "checked" && datasets.some(other => other.id === dataset.parent_dataset_id)));
    // A long list is not read whole: the service counts and pages it.
    void preloadRows([
      ...new Set(
        primary
          .map(dataset => marksSource(dataset, datasets))
          .filter(source => !isLarge(source))
          .map(source => source.id),
      ),
    ]);
  }, [datasets]);
  const selected = datasets?.find(dataset => dataset.id === (selectedId ?? datasets[0]?.id));
  const setupId = selected?.kind === "checked" ? (selected.parent_dataset_id ?? selected.id) : selected?.id;
  useEffect(() => {
    if (setupId) skiptraceSuggest(setupId).catch(() => undefined);
  }, [setupId]);

  // What the menu behind the mark in the title bar offers.
  const menu: MenuAction[] = [
    { label: "Switch or create a project", onSelect: () => setChoosing(true) },
    {
      label: "Import a file",
      disabled: !project || choosing,
      // A browser tab cannot open a file dialog on the service's side; the Lists tab has a box to type the path.
      onSelect: () => {
        if (!inDesktop) return setTab("lists");
        void pickImportFile()
          .then(async file => {
            if (!file) return;
            const imported = await importFile(file);
            const left = describeLeftOut(imported);
            setNote(left ? `Left out ${left} from the imported file.` : null);
            await refresh();
            setSelectedId(imported.dataset_id);
            setTab("lists");
          })
          .catch(fail);
      },
    },
    {
      label: "Back up this project",
      hint: "One file with every list, check, note and stored file",
      disabled: !project || choosing,
      onSelect: () => {
        if (!project) return;
        void backupProject(project.name).then(made => {
          if (made)
            setNote(
              `Backed up to ${made.path} (${Math.max(1, Math.round(made.size / 1024)).toLocaleString("en-US")} KB). Unpacked into an empty folder, it opens as this project.`,
            );
        }, fail);
      },
    },
    {
      label: "Reload lists",
      hint: "Reads them again from the project",
      disabled: !project || choosing,
      onSelect: () => {
        clearRowsCache();
        clearSuggestions();
        refresh().catch(fail);
      },
    },
  ];

  const gate = project === null || choosing;
  const shown = (id: TabId) => id === tab || openedTabs.includes(id);

  return (
    <ContextMenuProvider general={() => menu.map(action => ({ label: action.label, disabled: action.disabled, onSelect: action.onSelect }))}>
      <div className="window">
        <DropImport
          project={project ?? null}
          onAdded={async id => {
            await refresh();
            setSelectedId(id);
            setChoosing(false);
            setTab("lists");
          }}
        />
        <TitleBar
          title="Turf"
          mark={
            <AppMenu
              project={project ?? null}
              actions={menu}
              onOpenProject={path => void openProject(path).then(opened, fail)}
              mark={
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 5h16v4.4h-5.6V20H9.6V9.4H4z" fill="currentColor" />
                </svg>
              }
            />
          }
        >
          {!gate && (
            <nav className="tabs" aria-label="Sections">
              {TABS.map(item => (
                <button key={item.id} type="button" className="tab" aria-current={tab === item.id ? "page" : undefined} onClick={() => setTab(item.id)}>
                  {item.label}
                </button>
              ))}
            </nav>
          )}
        </TitleBar>
        <div className="scroller" ref={scroller}>
          <div className="shell">
            {error && (
              <p className="notice" role="alert">
                <span>{error}</span>
                <button type="button" className="button" onClick={() => (project === undefined ? void start() : setError(null))}>
                  {project === undefined ? "Try again" : "Dismiss"}
                </button>
              </p>
            )}
            {note && !gate && (
              <p className="notice good" role="status">
                <span>{note}</span>
                <button type="button" className="button" onClick={() => setNote(null)}>
                  Dismiss
                </button>
              </p>
            )}
            {gate ? (
              <ProjectGate onOpen={opened} onCancel={project ? () => setChoosing(false) : undefined} />
            ) : turf ? (
              <main>
                {shown("dashboard") && (
                  <div hidden={tab !== "dashboard"}>
                    <Dashboard turf={turf} />
                  </div>
                )}
                {shown("lists") && (
                  <div hidden={tab !== "lists"}>
                    <Lists turf={turf} />
                  </div>
                )}
                {shown("skiptracing") && (
                  <div hidden={tab !== "skiptracing"}>
                    <SkipTracing turf={turf} />
                  </div>
                )}
                {shown("calls") && (
                  <div hidden={tab !== "calls"}>
                    <Calls turf={turf} />
                  </div>
                )}
              </main>
            ) : (
              !error && <p className="loading">Loading lists…</p>
            )}
          </div>
        </div>
      </div>
    </ContextMenuProvider>
  );
}
