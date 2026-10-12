import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { inDesktop, nanpaBlocksImport, nanpaBlocksStatus, pickRegistryFile, type BlocksStatus } from "../lib/service";
import { formatNumber } from "../lib/marks";

/** The NANPA number-block line of "Ready to check": numbers in blocks no carrier has are flagged in every phone check. */
export function NanpaBlocks({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<BlocksStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { nanpaBlocksStatus().then(setState, () => setState(null)); }, []);

  async function load(file: string | null) {
    if (!file) return;
    setBusy(true); setMessage(null);
    try {
      const result = await nanpaBlocksImport(file);
      setMessage(`Loaded ${formatNumber(result.assigned)} assigned blocks in ${result.area_codes} area codes.`);
      setState(await nanpaBlocksStatus()); setTyping(false); onChanged();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const loaded = Boolean(state?.area_codes);
  const old = (state?.oldest_days ?? 0) > 90;
  return (
    <li className={loaded && !old ? "ok" : "needs"}>
      <Icon name={loaded && !old ? "check" : "flag"} size={14} />
      <span>
        {loaded
          ? <>NANPA number blocks: {formatNumber(state!.assigned)} assigned blocks in {state!.area_codes} area codes, file {state!.oldest_days ?? 0} days old. Numbers in blocks no carrier has are marked suspicious.{old && <strong> Download a fresh file: blocks keep being assigned.</strong>}</>
          : <>NANPA number blocks not loaded. In your browser, open nanpa.com, Reports, Central Office Code Assignment Records, and download the utilized codes for your states (outside the US, turn on a US VPN first). Load the file here to flag numbers in blocks no carrier has.</>}
        {busy && <small className="registry-progress"> Reading…</small>}
        {message && <small className="registry-progress"> {message}</small>}
        {typing && !inDesktop && (
          <span className="registry-path">
            <input className="input" value={path} placeholder="Path to the downloaded file" aria-label="Path to the downloaded NANPA file" onChange={event => setPath(event.target.value)} />
            <button type="button" className="button small" disabled={busy || !path.trim()} onClick={() => void load(path.trim())}>Load</button>
          </span>
        )}
      </span>
      <button type="button" className="link" disabled={busy} onClick={() => (inDesktop ? void pickRegistryFile().then(load) : setTyping(!typing))}>{loaded ? "Load a newer file" : "Load a file"}</button>
    </li>
  );
}
