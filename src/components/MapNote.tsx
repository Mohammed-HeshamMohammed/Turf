import { useEffect, useRef, useState } from "react";
import { cancelJob, locateAddresses, type AddressColumns, type LocateProgress, type Located, type placeRows } from "../lib/geo";
import { formatNumber } from "../lib/marks";

/** Addresses already tried this session, so a list is looked up on its own once and a failure does not repeat. */
const tried = new Set<string>();

/**
 * Under the map: how the rows were placed, which were left off and why, and the lookup of exact addresses. The lookup
 * starts by itself when a list is shown, so each property ends up on its own address; it can be stopped, and what was
 * found before then is kept.
 */
export function MapNote({ placement, located, columns, datasetId, onStatus, onLocated, onError }: {
  placement: ReturnType<typeof placeRows>; located: Located | null; columns: AddressColumns | null; datasetId: string;
  onStatus: (text: string | null) => void; onLocated: () => void; onError: (reason: unknown) => void;
}) {
  const [progress, setProgress] = useState<LocateProgress | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const waiting = located?.addresses_to_look_up ?? 0;
  const n = formatNumber;
  const placed = [
    placement.own && `${n(placement.own)} by their own coordinates`,
    placement.exact && `${n(placement.exact)} at their exact address`,
    placement.byZip && `${n(placement.byZip)} at the centre of their ZIP`,
  ].filter(Boolean);
  const left = [
    placement.stateDisagrees && `${n(placement.stateDisagrees)} whose ZIP is not in their state`,
    placement.unknownZip && `${n(placement.unknownZip)} with a ZIP that is not a known area`,
    placement.noZip && `${n(placement.noZip)} with no ZIP`,
  ].filter(Boolean);

  async function locate() {
    if (!columns) return;
    setResult(null);
    setProgress({ done: 0, total: waiting, found: 0 });
    let shownAt = 0;
    try {
      const done = await locateAddresses(datasetId, columns, update => {
        setProgress(update);
        // Pins appear as they are found, not only at the end.
        if (update.done - shownAt >= 250) { shownAt = update.done; onLocated(); }
      }, setJobId);
      setResult(`Looked up ${n(done.looked_up)} addresses: ${n(done.found)} found, ${n(done.not_found)} not matched in their own state and ZIP.`);
    } catch (reason) {
      // Cancelling is not an error. What was found before it stopped is kept either way.
      if (reason instanceof Error && /cancel/i.test(reason.message)) setResult("Stopped. The addresses found so far are kept.");
      else onError(reason);
    }
    setProgress(null);
    setJobId(null);
    onLocated();
  }

  // Starts on its own, once for each list.
  const start = useRef(locate);
  start.current = locate;
  const key = columns ? `${datasetId}:${columns.street}:${columns.zip ?? ""}:${columns.city ?? ""}:${columns.state ?? ""}` : "";
  useEffect(() => {
    if (!key || waiting === 0 || tried.has(key)) return;
    tried.add(key);
    void start.current();
  }, [key, waiting]);

  useEffect(() => {
    onStatus(progress ? `Finding each property's address · ${n(progress.found)} of ${n(progress.total)}` : null);
    return () => onStatus(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress?.found, progress?.total, Boolean(progress)]);

  return (
    <div className="map-note">
      {placed.length > 0 && <p><strong>On the map:</strong> {placed.join(", ")}.</p>}
      {left.length > 0 && <p className="muted"><strong>Left off:</strong> {left.join(", ")}.</p>}
      {progress ? (
        <p className="notice" role="status">
          <span>Looking up addresses: {n(progress.done)} of {n(progress.total)} · {n(progress.found)} found. Only the street, city, state and ZIP are sent, to the US Census Bureau&apos;s geocoder.</span>
          <button type="button" className="button ghost small" disabled={!jobId} onClick={() => jobId && void cancelJob(jobId).catch(onError)}>Stop</button>
        </p>
      ) : columns && waiting > 0 ? (
        <p className="row">
          <button type="button" className="button ghost small" onClick={() => void locate()}>Find exact addresses</button>
          <span className="muted">{n(waiting)} addresses not looked up yet.</span>
        </p>
      ) : null}
      {result && <p className="muted" role="status">{result}</p>}
    </div>
  );
}
