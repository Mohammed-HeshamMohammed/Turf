import { useEffect, useState } from "react";
import { createProject, inDesktop, openProject, pickFolder, recentProjects, type Project } from "../lib/service";
import { formatDate } from "../lib/marks";

/** Shown until a project is open. A project is a folder holding the lists; a DataForge project folder opens as it is. */
export function ProjectGate({ onOpen, onCancel }: { onOpen: (project: Project) => void; onCancel?: () => void }) {
  const [recent, setRecent] = useState<Project[] | null>(null);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    recentProjects().then(setRecent, reason => { setRecent([]); setError(reason instanceof Error ? reason.message : String(reason)); });
  }, []);

  async function run(action: () => Promise<Project>) {
    setBusy(true);
    setError(null);
    try {
      onOpen(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setBusy(false);
    }
  }

  const folder = path.trim();

  return (
    <section className="gate">
      <header className="list-head">
        <div>
          <h1>Open a project</h1>
          <p>A project is a folder that holds your lists. Start one here, or open a folder made by DataForge.</p>
        </div>
        {onCancel && <button type="button" className="button ghost" onClick={onCancel}>Back to the open project</button>}
      </header>
      {error && <p className="notice" role="alert">{error}</p>}

      <div className="gate-grid">
        <article className="card step">
          <header><h2>Recent projects</h2></header>
          {!recent ? <p className="muted">Looking…</p> : recent.length ? (
            <ul className="project-list">
              {recent.map(project => (
                <li key={project.root_path}>
                  <button type="button" disabled={busy} onClick={() => void run(() => openProject(project.root_path))}>
                    <strong>{project.name}</strong>
                    <span>{project.root_path}</span>
                    <small>Created {formatDate(project.created_at)}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="muted">No project has been opened in Turf yet.</p>}
        </article>

        <article className="card step">
          <header><h2>Another folder</h2></header>
          <label className="field">
            <span>Project folder</span>
            <div className="row nowrap">
              <input className="input grow" value={path} placeholder="C:\Projects\My lists" onChange={event => setPath(event.target.value)} />
              {inDesktop && <button type="button" className="button ghost" disabled={busy} onClick={() => void pickFolder().then(chosen => chosen && setPath(chosen))}>Browse</button>}
            </div>
          </label>
          <label className="field">
            <span>Name, when creating a new project</span>
            <input className="input" value={name} placeholder="My lists" onChange={event => setName(event.target.value)} />
          </label>
          <div className="row">
            <button type="button" className="button" disabled={busy || !folder} onClick={() => void run(() => openProject(folder))}>Open</button>
            <button type="button" className="button ghost" disabled={busy || !folder} onClick={() => void run(() => createProject(folder, name.trim() || "My lists"))}>Create here</button>
          </div>
        </article>
      </div>
    </section>
  );
}
