import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { dncRegistryImport, dncRegistryStatus, inDesktop, pickRegistryFile, type RegistryStatus } from "../lib/service";
import { formatNumber } from "../lib/marks";

/**
 * The National Do Not Call Registry line of "Ready to check": which area codes are loaded and how old their file is, and
 * a way to load the file the person downloaded. Numbers on it are blocked in every phone check, in every project.
 */
export function DncRegistry({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<RegistryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState(0);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { dncRegistryStatus().then(setState, () => setState(null)); }, []);

  async function load(file: string | null) {
    if (!file) return;
    setBusy(true); setMessage(null); setLines(0);
    try {
      const result = await dncRegistryImport(file, setLines);
      setMessage(`Loaded ${formatNumber(result.numbers)} numbers for ${result.area_codes.join(", ")}.`);
      setState(await dncRegistryStatus()); setTyping(false); onChanged();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const codes = state?.area_codes ?? [];
  const old = codes.filter(code => code.out_of_date);
  const newest = codes.length ? Math.min(...codes.map(code => code.age_days)) : 0;
  return (
    <li className={codes.length && !old.length ? "ok" : "needs"}>
      <Icon name={codes.length && !old.length ? "check" : "flag"} size={14} />
      <span>
        {codes.length
          ? <>National Do Not Call Registry: {formatNumber(state!.numbers)} numbers for {codes.map(code => code.area_code).join(", ")}, file {newest === 0 ? "from today" : `${newest} ${newest === 1 ? "day" : "days"} old`}. Other area codes are not checked.
              {old.length > 0 && <> <strong>{old.map(code => code.area_code).join(", ")} {old.length === 1 ? "is" : "are"} older than {state!.max_age_days} days: download a fresh file.</strong></>}</>
          : <>National Do Not Call Registry not loaded. Your first five area codes are free at telemarketing.donotcall.gov: register, download them, and load the file here.</>}
        {busy && <small className="registry-progress"> Reading… {formatNumber(lines)} lines</small>}
        {message && <small className="registry-progress"> {message}</small>}
        {typing && !inDesktop && (
          <span className="registry-path">
            <input className="input" value={path} placeholder="Path to the downloaded file" aria-label="Path to the downloaded registry file" onChange={event => setPath(event.target.value)} />
            <button type="button" className="button small" disabled={busy || !path.trim()} onClick={() => void load(path.trim())}>Load</button>
          </span>
        )}
      </span>
      <button type="button" className="link" disabled={busy} onClick={() => (inDesktop ? void pickRegistryFile().then(load) : setTyping(!typing))}>{codes.length ? "Load a newer file" : "Load a file"}</button>
    </li>
  );
}
