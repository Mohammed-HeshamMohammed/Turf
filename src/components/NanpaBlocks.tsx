import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { inDesktop, nanpaBlocksImport, nanpaBlocksStatus, pickNanpaFile, type BlocksStatus } from "../lib/service";
import { formatNumber } from "../lib/marks";

/** The NANPA number-block line of "Ready to check": numbers in blocks no carrier has are flagged in every phone check. */
export function NanpaBlocks({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<BlocksStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    nanpaBlocksStatus().then(value => { if (current) setState(value); }, reason => { if (current) setMessage(String(reason)); });
    return () => { current = false; };
  }, []);

  async function load(file: string | null) {
    if (!file) return;
    setBusy(true); setMessage(null);
    try {
      const result = await nanpaBlocksImport(file);
      setMessage(`Loaded ${formatNumber(result.assigned)} utilized blocks and ${formatNumber(result.free)} available blocks in ${result.area_codes} area codes.`);
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
          ? <>NANPA number blocks: {formatNumber(state!.assigned)} utilized blocks in {state!.area_codes} area codes, file {state!.oldest_days ?? 0} days old. Available blocks and blocks missing from a utilized-code file are marked suspicious. Other area codes are not checked.{old && <strong> Download a fresh file: blocks keep being assigned.</strong>}</>
          : <>NANPA number blocks not loaded. Download the tab-delimited utilized codes for your region from <a href="https://nanpa.com/reports/co-code-reports/cocodes_assign" target="_blank" rel="noreferrer">NANPA's Central Office Code Assignment Records</a>, then load the ZIP or extracted text file here.</>}
        {busy && <small className="registry-progress"> Reading…</small>}
        {message && <small className="registry-progress"> {message}</small>}
        {typing && !inDesktop && (
          <span className="registry-path">
            <input className="input" value={path} placeholder="Path to the downloaded file" aria-label="Path to the downloaded NANPA file" onChange={event => setPath(event.target.value)} />
            <button type="button" className="button small" disabled={busy || !path.trim()} onClick={() => void load(path.trim())}>Load</button>
          </span>
        )}
      </span>
      <button type="button" className="link" disabled={busy} onClick={() => (inDesktop ? void pickNanpaFile().then(load).catch(reason => setMessage(String(reason))) : setTyping(!typing))}>{loaded ? "Load newer NANPA file" : "Load NANPA file"}</button>
    </li>
  );
}
