import { useEffect, useState } from "react";
import { api } from "./remote/api.ts";
import { Badge, Button, Card, Field, Select, count } from "./ui.jsx";

const label = {
  loaded: "Not processed",
  clean: "Prepared",
  near_duplicate: "Needs review",
  skip: "Excluded",
  import: "Ready to add",
  merge: "Ready to merge",
  merged: "Added to CRM",
};

export function SourceRows({ jobs, navigate }) {
  const [selectedId, setSelectedId] = useState(jobs[0]?.id || "");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (jobs.some(job => job.id === selectedId)) return;
    setSelectedId(jobs[0]?.id || "");
    setOffset(0);
  }, [jobs, selectedId]);
  const job = jobs.find(item => item.id === selectedId) || jobs[0];
  const jobId = job?.id;
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    const load = async () => {
      try {
        const [nextDetail, nextPage] = await Promise.all([api.imports.get(jobId), api.imports.rows(jobId, offset)]);
        if (!active) return;
        setDetail(nextDetail);
        setPage(nextPage);
        setError("");
      } catch (reason) {
        if (active) setError(reason.message || "Source rows could not be loaded.");
      }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, [jobId, offset]);
  if (!jobs.length) return null;
  const rows = page?.rows || [];
  const headers = detail?.columns?.map(column => column.header) || [];
  const width = Math.max(headers.length, ...rows.map(row => row.cells?.length || 0), 0);
  return <Card title="Uploaded source rows" subtitle="Original values are kept here while their processing status changes." className="source-rows-card">
    {jobs.length > 1 && <Field label="Upload attempt"><Select value={job?.id || ""} onChange={event => { setSelectedId(event.target.value); setOffset(0); setPage(null); }}>
      {jobs.map(item => <option key={item.id} value={item.id}>{item.filename} · {new Date(item.created_at).toLocaleString()}</option>)}
    </Select></Field>}
    {error && <p className="notice" role="alert">{error}</p>}
    {!page && !error && <p className="muted">Loading source rows…</p>}
    {page && rows.length === 0 && <p className="muted">{job?.status === "uploading" || job?.status === "queued" || job?.status === "loading"
      ? "Source rows will appear here as the worker reads the uploaded file."
      : "No source rows are available for this upload."}</p>}
    {rows.length > 0 && <div className="source-rows-scroll"><table className="source-rows-table">
      <thead><tr><th scope="col">Row</th>{Array.from({ length: width }, (_, i) => <th scope="col" key={i}>{headers[i] || `Column ${i + 1}`}</th>)}<th scope="col">Status</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.row_no}>
        <th scope="row">{row.row_no}</th>
        {Array.from({ length: width }, (_, i) => <td key={i} title={row.cells?.[i] || ""}>{row.cells?.[i] || <span className="muted">—</span>}</td>)}
        <td><Badge tone={row.state === "near_duplicate" ? "peach" : row.state === "skip" && !row.lead_id ? "danger" : undefined}>{row.state === "skip" && row.lead_id ? "Already in CRM" : label[row.state] || row.state}</Badge>
          {row.lead_id && <button className="text-button" onClick={() => navigate(`work/leads/${row.lead_id}`)}>Open lead</button>}</td>
      </tr>)}</tbody>
    </table></div>}
    {page && page.total > 0 && <div className="source-rows-pager">
      <span>{(offset + 1).toLocaleString()}–{Math.min(offset + rows.length, page.total).toLocaleString()} of {count(Number(page.total))} source rows</span>
      <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</Button>
      <Button disabled={offset + rows.length >= page.total} onClick={() => setOffset(offset + 50)}>Next</Button>
    </div>}
  </Card>;
}
