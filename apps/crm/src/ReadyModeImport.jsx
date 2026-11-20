import { useEffect, useRef, useState } from "react";
import { api } from "./remote/api.ts";
import { follow, uploadFile } from "./remote/imports.ts";
import { useCrm } from "./context.jsx";
import { Button, Card, PageHeader, Select } from "./ui.jsx";

const zones = [
  ["America/New_York", "US Eastern"], ["America/Chicago", "US Central"],
  ["America/Denver", "US Mountain"], ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "US Pacific"], ["UTC", "UTC"],
];
const number = value => Number(value || 0).toLocaleString();

export function ReadyModeImport() {
  const { dispatch, navigate, notify, state } = useCrm();
  const [file, setFile] = useState(null);
  const [zone, setZone] = useState(state.remote?.timezone || state.settings?.timezone || "");
  const [job, setJob] = useState(null);
  const [recent, setRecent] = useState([]);
  const [preview, setPreview] = useState([]);
  const [sent, setSent] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const stop = useRef(new AbortController());
  useEffect(() => {
    const controller = stop.current;
    void api.imports.list("readymode_calls").then(setRecent).catch(() => {});
    return () => controller.abort();
  }, []);

  async function track(id) {
    const next = await follow(id, setJob, { signal: stop.current.signal });
    setJob(next);
    if (next.status === "call_ready") await loadPreview(id);
    if (next.status === "done") {
      notify("ReadyMode call history added to your CRM.");
      dispatch({ type: "SYNC" });
    } else if (next.status === "failed") notify("This call history needs attention.");
    void api.imports.list("readymode_calls").then(setRecent).catch(() => {});
  }
  async function loadPreview(id) {
    try {
      const page = await api.imports.rows(id);
      setPreview((page.rows || []).slice(0, 10));
    } catch { setPreview([]); }
  }
  async function upload() {
    if (!file || !zone || busy) return;
    if (job?.status === "uploading" && (job.filename !== file.name || job.size !== file.size)) {
      setError("Choose the same file to resume this upload.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await uploadFile(file, {
        kind: "readymode_calls", sourceTimezone: zone, resumeId: job?.status === "uploading" ? job.id : undefined,
        onProgress: ({ sent: bytes, total, job: started }) => { setSent({ bytes, total }); setJob(current => current ?? started); },
        signal: stop.current.signal,
      });
      setSent(null);
      setJob(next);
      notify("ReadyMode file received. Checking its calls.");
      await track(next.id);
    } catch (reason) {
      if (reason?.name !== "AbortError") {
        setError(reason.message || "The call log could not be uploaded.");
        notify(reason.message || "The call log could not be uploaded.");
      }
    } finally {
      setSent(null);
      setBusy(false);
    }
  }
  async function action(work) {
    setBusy(true);
    setError("");
    try {
      const next = await work();
      setJob(next);
      notify("Adding historical calls to your CRM.");
      await track(next.id);
    } catch (reason) {
      setError(reason.message || "That action could not finish.");
      notify(reason.message || "That action could not finish.");
    } finally {
      setBusy(false);
    }
  }
  async function open(id) {
    setError("");
    try {
      const next = await api.imports.get(id);
      setJob(next);
      setZone(next.source_timezone || "");
      setPreview([]);
      if (next.status === "call_ready") await loadPreview(id);
      if (!["call_ready", "done", "failed", "cancelled", "uploading"].includes(next.status)) void track(id);
    } catch (reason) { setError(reason.message || "That import could not be opened."); }
  }
  const status = job?.status;
  const report = job?.report || {};
  const working = ["queued", "loading", "call_merging"].includes(status);
  return <div className="readymode-import">
    <PageHeader title="Import ReadyMode calls" description="Bring your call history into this workspace." />
    <Card title="ReadyMode call log">
      <p className="muted">Use a ReadyMode call log CSV. Its original rows stay in PostgreSQL. Calls match an existing lead only when the name and contact details agree; other people get a new lead.</p>
      {(!job || status === "uploading") && <div className="import-actions">
        <label>Call log CSV <input type="file" accept=".csv,text/csv" onChange={event => setFile(event.target.files?.[0] || null)} /></label>
        <label>Time zone used by ReadyMode
          <Select aria-label="ReadyMode export time zone" value={zone} onChange={event => setZone(event.target.value)}>
            <option value="">Choose a time zone</option>
            {zone && !zones.some(([value]) => value === zone) && <option value={zone}>{zone} (workspace)</option>}
            {zones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
        <Button variant="primary" disabled={!state.online || !file || !zone || busy || !file.name.toLowerCase().endsWith(".csv")} onClick={upload}>
          {status === "uploading" ? "Resume upload" : "Upload call history"}
        </Button>
      </div>}
      {sent && <p role="status">Sending {number(sent.bytes)} of {number(sent.total)} bytes.</p>}
      {working && <p role="status">{status === "call_merging" ? `Added ${number(job.merged_rows)} of ${number(report.valid_calls)} calls. You can leave this page.` : "Reading the call history. You can leave this page."}</p>}
      {status === "call_ready" && <>
        <p><strong>{number(report.valid_calls)} calls</strong> are ready. {number(report.unusable_calls)} rows lacked a usable call time or phone and will stay in the source rows.</p>
        <p className="muted">Agent, outcome, date, notes, scheduled time and recording timestamps are retained. The export contains recording times, not audio. Past scheduled times will not become new callbacks; do-not-call outcomes block dialing.</p>
        <p>Time zone: {zones.find(([value]) => value === job.source_timezone)?.[1] || job.source_timezone}</p>
        {report.first_call && <p className="muted">Calls run from {new Date(report.first_call).toLocaleString()} to {new Date(report.last_call).toLocaleString()}, shown in your time zone. If that is not when they happened, cancel and upload again with the right time zone.</p>}
        {report.future_calls > 0 && <p className="notice" role="alert">{number(report.future_calls)} {report.future_calls === 1 ? "call is" : "calls are"} dated in the future, so the time zone chosen is probably wrong. Cancel and upload again with the right one.</p>}
        <div className="row">{Object.entries(report.outcomes || {}).sort((a, b) => b[1] - a[1]).map(([name, count]) => <span key={name}>{name}: {number(count)}</span>)}</div>
        {preview.length > 0 && <div className="readymode-preview"><h3>First source rows</h3>
          <p className="muted">These are the original values saved from your export. Rows without a usable call remain here.</p>
          {preview.map(row => {
            const field = header => row.cells?.[job.columns?.find(column => column.header.toLowerCase() === header.toLowerCase())?.idx] || "";
            return <div className="row" key={row.row_no}><span>#{row.row_no}</span><strong>{[field("First Name"), field("Last Name")].filter(Boolean).join(" ") || field("Phone") || "Unnamed"}</strong><span>{field("Log Time")}</span><span>{field("Log Type")}</span><span>{row.state === "skip" ? "No usable call" : "Ready"}</span></div>;
          })}
        </div>}
        <div className="import-actions"><Button variant="primary" disabled={busy || !state.online} onClick={() => action(() => api.imports.applyCalls(job.id))}>Add these calls</Button></div>
      </>}
      {status === "done" && <p role="status">{number(job.merged_rows)} calls were linked to leads. Repeated calls already in the CRM were not added twice.</p>}
      {status === "failed" && <><p role="alert">{job.error}</p><p className="muted">Import ID: {job.id}</p>
        {job.progress?.phase === "call_merging" && <Button disabled={busy} onClick={() => action(() => api.imports.retry(job.id))}>Retry adding calls</Button>}</>}
      {error && <p role="alert" className="notice">{error}</p>}
      <div className="import-actions"><Button onClick={() => navigate("work/calls?view=log")}>Back to call log</Button></div>
    </Card>
    {recent.length > 0 && <Card title="Recent call imports">
      {recent.map(item => <div className="row" key={item.id}><strong>{item.name}</strong><span>{item.status}</span><span>{number(item.merged_rows)} calls</span><Button onClick={() => open(item.id)}>Open</Button></div>)}
    </Card>}
  </div>;
}
