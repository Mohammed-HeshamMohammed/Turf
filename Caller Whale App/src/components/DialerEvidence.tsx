import { useState } from "react";
import type { CallerWhale } from "../App";
import { importFile, inDesktop, pickImportFile } from "../lib/service";
import { Field } from "./Bits";

/** Any dialer's CSV/XLSX export can be mapped using the existing outcome workflow. */
export function DialerEvidence({ callerwhale, datasetId }: { callerwhale: CallerWhale; datasetId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sources = callerwhale.datasets.filter(dataset => dataset.kind !== "checked" && dataset.id !== datasetId);
  async function bringIn(file: string | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importFile(file);
      await callerwhale.refresh();
      setSelected(imported.dataset_id);
      setTyping(false);
      setPath("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dialer-evidence">
      <h3>Use your existing dialer's results</h3>
      <p className="muted">
        Import the dialer's CSV or Excel export, choose the exact phone-number column called, map its call statuses, and choose its call date/time column when
        available. Save those mappings, then check your lead list. Caller Whale reads the mapped export as evidence across this project. No Twilio account, credentials,
        or additional lookup subscription is needed.
      </p>
      <div className="row">
        <button
          type="button"
          className="button ghost small"
          disabled={busy}
          onClick={() => {
            if (inDesktop)
              void pickImportFile()
                .then(bringIn)
                .catch(reason => setError(String(reason)));
            else setTyping(!typing);
          }}
        >
          {busy ? "Importing dialer export…" : "Import dialer results"}
        </button>
      </div>
      {typing && (
        <div className="row">
          <label className="field grow">
            <span>Dialer export file path</span>
            <input className="input" value={path} placeholder="Full path to dialer CSV or Excel file" onChange={event => setPath(event.target.value)} />
          </label>
          <button type="button" className="button small" disabled={busy || !path.trim()} onClick={() => void bringIn(path.trim())}>
            Add dialer export
          </button>
        </div>
      )}
      {sources.length > 0 && (
        <div className="row">
          <Field
            label="Dialer export already in this project"
            value={selected}
            optional="Choose a list"
            searchable
            options={sources.map(dataset => ({ value: dataset.id, label: dataset.name }))}
            onChange={setSelected}
          />
          <button type="button" className="button ghost small" disabled={!selected || busy} onClick={() => selected && callerwhale.open("skiptracing", selected)}>
            Map this export's outcomes
          </button>
        </div>
      )}
      {selected && (
        <p className="muted">
          Open the export, use Call outcomes to save its mappings, then return to your lead list. Originals and earlier checked copies remain available.
        </p>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
