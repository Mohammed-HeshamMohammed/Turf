import { useEffect, useRef, useState, type ReactNode } from "react";
import { recentProjects, type Project } from "../lib/service";

export type MenuAction = { label: string; hint?: string; onSelect: () => void; disabled?: boolean };

/**
 * The app's mark in the title bar, as a button. Pressing it opens the app's menu: the project that is open,
 * the other recent ones, and the actions passed in.
 */
export function AppMenu({
  mark,
  project,
  actions,
  onOpenProject,
}: {
  mark: ReactNode;
  project: Project | null;
  actions: MenuAction[];
  onOpenProject: (path: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<Project[]>([]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    // Asked for each time the menu opens, so a project opened a moment ago is listed.
    recentProjects().then(
      list => current && setRecent(list),
      () => undefined,
    );
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      current = false;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const others = recent.filter(item => item.root_path !== project?.root_path).slice(0, 5);
  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="app-menu" ref={root}>
      <button type="button" className="brand-mark" aria-label="Turf menu" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {mark}
      </button>
      {open && (
        <div className="app-menu-panel" role="menu">
          <div className="app-menu-project">
            <small>{project ? "Open project" : "No project open"}</small>
            {project && <strong>{project.name}</strong>}
            {project && <span>{project.root_path}</span>}
          </div>
          {others.length > 0 && (
            <div className="app-menu-group">
              <small>Recent projects</small>
              {others.map(item => (
                <button key={item.root_path} type="button" role="menuitem" title={item.root_path} onClick={() => run(() => onOpenProject(item.root_path))}>
                  {item.name}
                </button>
              ))}
            </div>
          )}
          <div className="app-menu-group">
            {actions.map(action => (
              <button key={action.label} type="button" role="menuitem" disabled={action.disabled} onClick={() => run(action.onSelect)}>
                {action.label}
                {action.hint && <span>{action.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
