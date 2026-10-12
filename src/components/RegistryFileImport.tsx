import { useEffect, useState, type ReactNode } from "react";
import { inDesktop } from "../lib/service";
import { Icon } from "./Icon";

export type RegistrySource<State, Result> = {
  read: () => Promise<State>;
  load: (path: string, onLines: (lines: number) => void) => Promise<Result>;
  pick: () => Promise<string | null>;
  describe: (result: Result) => string;
  ready: (state: State | null) => boolean;
  button: (state: State | null) => string;
  pathLabel: string;
  progress?: (lines: number) => string;
  showStatusError?: boolean;
};

/** Common file loading controls; each registry supplies its own coverage, age and import messages. */
export function RegistryFileImport<State, Result>({ source, onChanged, children }: {
  source: RegistrySource<State, Result>; onChanged: () => void; children: (state: State | null) => ReactNode;
}) {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState(0);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    source.read().then(value => { if (current) setState(value); }, reason => {
      if (current && source.showStatusError) setMessage(String(reason));
    });
    return () => { current = false; };
  }, [source]);

  async function load(file: string | null) {
    if (!file) return;
    setBusy(true); setMessage(null); setLines(0);
    try {
      const result = await source.load(file, setLines);
      setMessage(source.describe(result));
      setState(await source.read());
      setTyping(false);
      onChanged();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const chooseFile = () => {
    if (inDesktop) void source.pick().then(load).catch(reason => setMessage(String(reason)));
    else setTyping(!typing);
  };
  const ready = source.ready(state);
  return (
    <li className={ready ? "ok" : "needs"}>
      <Icon name={ready ? "check" : "flag"} size={14} />
      <span>
        {children(state)}
        {busy && <small className="registry-progress"> {source.progress?.(lines) ?? "Reading…"}</small>}
        {message && <small className="registry-progress"> {message}</small>}
        {typing && !inDesktop && <span className="registry-path">
          <input className="input" value={path} placeholder="Path to the downloaded file" aria-label={source.pathLabel} onChange={event => setPath(event.target.value)} />
          <button type="button" className="button small" disabled={busy || !path.trim()} onClick={() => void load(path.trim())}>Load</button>
        </span>}
      </span>
      <button type="button" className="link" disabled={busy} onClick={chooseFile}>{source.button(state)}</button>
    </li>
  );
}
