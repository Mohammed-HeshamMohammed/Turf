import { useEffect, useRef, useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { api } from "./remote/api.ts";
import { importStatusMessage } from "./remote/source-list-imports.js";
import { IMPORT_FIELDS, SOURCE_IMPORT_FIELDS, follow, mappingBody, mappingProblem, uploadFile } from "./remote/imports.ts";
import { useCrm } from "./context.jsx";
import { SourceRows } from "./SourceRows.jsx";
import { Badge, Breadcrumb, Button, Card, Checkbox, Field, PageHeader, Select } from "./ui.jsx";
import { LiquidProgress } from "./LiquidProgress.jsx";

// One page for every step of a server import. The upload's project ID ties this page to its source list.

const WORKING = {
  queued: "Waiting for its turn. One list is read at a time.",
  loading: "Reading your list",
  cleaning: "Tidying phone numbers, emails and addresses, and looking for repeats",
  merging: "Adding leads to your account",
  uploading: "Sending your list",
};
const number = (value) => Number(value || 0).toLocaleString();
const megabytes = (bytes) => (bytes / 1048576 >= 10 ? Math.round(bytes / 1048576).toLocaleString() : (bytes / 1048576).toFixed(1)) + " MB";

export function ServerImport({ resume = "", initialFile = null, projectId = null, projectName = "", onClose, onFinished, onStarted }) {
  const { navigate, notify, refreshImports } = useCrm();
  const [file, setFile] = useState(initialFile);
  const [name, setName] = useState(initialFile ? initialFile.name.replace(/\.[^.]+$/, "") : "");
  const [header, setHeader] = useState(true);
  const [job, setJob] = useState(null);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState({});
  const [repeats, setRepeats] = useState(null);
  const [repeatLimit, setRepeatLimit] = useState(12);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const stop = useRef(new AbortController());
  const uploading = useRef(false);
  const startedRoute = useRef(false);
  const lastStatus = useRef(null);
  useEffect(() => () => stop.current.abort(), []);

  async function track(id) {
    try {
      const next = await follow(id, setJob, { signal: stop.current.signal });
      if (lastStatus.current && lastStatus.current !== next.status && importStatusMessage(next)) notify(importStatusMessage(next));
      lastStatus.current = next.status;
      void refreshImports?.().catch(() => {});
      if (next.status === "reviewing") setRepeats(await api.imports.duplicates(id));
      if (next.status === "done") onFinished?.(next);
    } catch (reason) {
      if (reason?.name !== "AbortError") {
        setError(reason.message || "The server cannot be reached.");
        notify(reason.message || "The import needs attention.");
      }
    }
  }
  useEffect(() => {
    if (!resume || uploading.current) return;
    void api.imports.get(resume).then(current => {
      setJob(current);
      if (current.status !== "uploading") void track(resume);
    }).catch(reason => setError(reason.message || "This import could not be loaded."));
  }, [resume]);

  async function upload() {
    setError("");
    if (job?.status === "uploading" && (file?.name !== job.filename || file?.size !== job.size)) {
      setError("Choose the same file to resume this upload.");
      return;
    }
    uploading.current = true;
    try {
      const queued = await uploadFile(file, {
        name: name.trim() || undefined,
        hasHeader: header,
        projectId: projectId || undefined,
        resumeId: job?.status === "uploading" ? job.id : undefined,
        signal: stop.current.signal,
        onProgress: ({ sent: bytes, total, job: started }) => {
          setSent({ bytes, total });
          setJob(current => current ?? started);
          if (!resume && !startedRoute.current) {
            startedRoute.current = true;
            onStarted?.(started);
          }
        },
      });
      setSent(null);
      setJob(queued);
      lastStatus.current = queued.status;
      notify("Upload received. Source rows are being read.");
      await track(queued.id);
    } catch (reason) {
      if (reason?.name === "AbortError") return;
      setSent(null);
      setError(reason.message || "The list could not be sent.");
      notify(reason.message || "The list could not be sent.");
    } finally {
      uploading.current = false;
    }
  }

  async function act(work, message) {
    setBusy(true);
    setError("");
    try {
      const next = await work();
      setJob(next);
      if (message) notify(message);
      await track(next.id);
    } catch (reason) {
      setError(reason.message || "That did not work. Try again.");
      notify(reason.message || "That action needs attention.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    stop.current.abort();
    stop.current = new AbortController();
    if (job) await api.imports.cancel(job.id).catch(() => {});
    if (job) notify("Import cancelled.");
    void refreshImports?.().catch(() => {});
    onClose(job);
  }

  const status = job?.status;
  const working = sent || (status === "uploading" && !uploading.current ? null : WORKING[status]);
  const percent = sent
    ? Math.round((sent.bytes / sent.total) * 100)
    : status === "merging" && job.progress?.total
      ? Math.round((job.merged_rows / job.progress.total) * 100)
      : status === "cleaning" && job.progress?.phase === "cleaning" && job.progress?.total > 0
        ? Math.min(99, Math.round((job.progress.done / job.progress.total) * 100))
        : null;
  // The steps after the tidying compare rows with each other and with the leads already in the account; the worker says which one it is on.
  const matching = status === "cleaning" && job?.progress?.phase === "matching";
  const columns = job?.columns ?? [];
  const knownFields = new Set([...IMPORT_FIELDS, ...SOURCE_IMPORT_FIELDS].map(([key]) => key));
  const additionalFields = [...new Map(columns.filter(column => column.source_detail && column.standard_key && !knownFields.has(column.standard_key))
    .map(column => [column.standard_key, [column.standard_key, column.source_detail]])).values()];
  const problem = status === "mapping" ? mappingProblem(columns, choices) : "";
  const report = job?.report ?? {};
  const repeatGroups = Object.values((repeats?.rows ?? []).reduce((groups, row) => {
    (groups[row.group_id] ??= []).push(row);
    return groups;
  }, {}));
  const lastLoadedGroup = repeats?.rows?.at(-1)?.group_id;
  async function showMoreRepeats() {
    if (!repeats || loadingMore) return;
    if (repeatLimit < repeatGroups.length) return setRepeatLimit(current => current + 12);
    if (repeats.rows.length >= repeats.total) return;
    setLoadingMore(true);
    try {
      const page = await api.imports.duplicates(job.id, repeats.rows.length);
      setRepeats(current => ({ ...current, total: page.total, rows: [...current.rows, ...page.rows] }));
      setRepeatLimit(current => current + 12);
    } catch (reason) {
      setError(reason.message || "More rows could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }

  const title = status === "mapping" ? "What is in each column?" : status === "reviewing" ? "Review possible repeats" : status === "ready" ? "Ready to add" : status === "done" ? "List added" : "Upload a list";
  const sourceListId = job?.project_id || projectId;
  const canResumeUpload = status === "uploading" && !sent && !uploading.current;
  const content = (
      <div className="server-import">
        {((!job && !resume) || canResumeUpload) && !sent && (
          <>
            <p className="muted">{canResumeUpload ? "Choose the same file to resume sending this list." : "CSV, TXT, XLSX or XLS. Big lists are sent in pieces and read on Caller Whale's server."}</p>
            <input
              ref={input}
              type="file"
              accept=".csv,.txt,.xlsx,.xls"
              hidden
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                if (chosen) (setFile(chosen), setName((current) => current || chosen.name.replace(/\.[^.]+$/, "")));
                event.target.value = "";
              }}
            />
            <div className="import-file">
              <Button icon={UploadSimple} onClick={() => input.current.click()}>
                {file ? "Choose another file" : "Choose a file"}
              </Button>
              {file && (
                <span>
                  {file.name} · {megabytes(file.size)}
                </span>
              )}
            </div>
            {!canResumeUpload && <Field label="List name">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Austin owners" maxLength={200} />
            </Field>}
            {!canResumeUpload && <Checkbox checked={header} onChange={(event) => setHeader(event.target.checked)} label="The first row names each column" />}
            <div className="import-actions">
              <Button onClick={() => onClose(job)}>Back to source lists</Button>
              {canResumeUpload && <Button onClick={cancel}>Cancel import</Button>}
              <Button variant="primary" disabled={!file} onClick={upload}>
                {canResumeUpload ? "Resume upload" : "Upload"}
              </Button>
            </div>
          </>
        )}
        {!job && resume && !error && <p className="muted">Loading this source list import…</p>}

        {working && (
          <div className="job-progress">
            <h3>{sent ? `Sending your list · ${percent}%` : matching ? "Looking for repeats" : working}</h3>
            <LiquidProgress value={percent} label={percent === null ? "Working" : `${percent} percent`} />
            <p>
              {sent &&
                `${megabytes(sent.bytes)} of ${megabytes(sent.total)}. You can leave this page and resume with the same file if the connection drops.`}
              {!sent && status === "loading" && job.loaded_rows > 0 && `${number(job.loaded_rows)} rows read so far.`}
              {!sent && status === "cleaning" && !matching && job.progress?.done > 0 && `${number(job.progress.done)} rows tidied so far.`}
              {!sent && matching && `${number(job.progress.done)} rows tidied. Now comparing them: ${job.progress.step || "repeats"}. A big list can take a few minutes.`}
              {!sent && status === "merging" && `${number(job.merged_rows)} of ${number(job.progress?.total)} added. You can leave this page; it carries on.`}
              {!sent && ["queued", "loading", "cleaning"].includes(status) && " You can leave this page; processing carries on in the background."}
            </p>
            <Button onClick={cancel}>{status === "merging" ? "Stop adding" : "Cancel this import"}</Button>
          </div>
        )}

        {status === "mapping" && (
          <>
            <p className="muted">
              {number(columns.filter(column => column.standard_key).length)} of {number(columns.length)} remaining columns recognized. Source fields keep their original values in this list; recognized property details also appear on new properties.
              {report.exact_duplicates > 0 && ` ${number(report.exact_duplicates)} identical rows were removed.`}
              {(report.empty_columns_removed || []).length > 0 && ` ${number(report.empty_columns_removed.length)} completely empty columns were removed from the source rows.`}
            </p>
            <div className="import-columns" role="table" aria-label="Columns in your list">
              {columns.map((column) => (
                <div className="import-column" role="row" key={column.idx}>
                  <div role="cell">
                    <strong>{column.header}</strong>
                    {column.source_detail && <small>Recognized as {column.source_detail} · saved in source rows</small>}
                    <small>{column.samples.length ? column.samples.slice(0, 2).join(" · ") : "Empty"}</small>
                    <small>
                      {number(column.populated)} of {number(report.rows)} rows filled
                    </small>
                  </div>
                  <div role="cell">
                    <Select
                      aria-label={`What ${column.header} is`}
                      value={(choices[column.idx] === undefined ? (column.suggested ?? (column.source_detail ? column.standard_key : null)) : choices[column.idx]) || ""}
                      onChange={(event) =>
                        setChoices({
                          ...choices,
                          [column.idx]: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Source row only</option>
                      <option value="" disabled>Lead fields</option>
                      {IMPORT_FIELDS.map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                      <option value="" disabled>Source and property fields</option>
                      {[...SOURCE_IMPORT_FIELDS, ...additionalFields].map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                    </Select>
                  </div>
                </div>
              ))}
            </div>
            {(problem || error) && (
              <p className="notice" role="alert">
                {problem || error}
              </p>
            )}
            <div className="import-actions">
              <Button onClick={cancel}>Cancel import</Button>
              <Button
                variant="primary"
                disabled={Boolean(problem) || busy}
                onClick={() => act(() => api.imports.mapping(job.id, mappingBody(columns, choices)), "Column mapping saved. Preparing source rows.")}
              >
                Continue
              </Button>
            </div>
          </>
        )}

        {status === "reviewing" && (
          <>
            <p className="muted">
              {report.exact_existing > 0 && `${number(report.exact_existing)} rows already in your CRM were linked automatically. `}
              {number(report.near_groups)} {report.near_groups === 1 ? "group may contain" : "groups may contain"} repeat leads.
              Names match along with a phone number, email, or address. Choose what happens to these rows.
            </p>
            <div className="import-repeat-groups">
              {repeatGroups.slice(0, repeatLimit).map(group => (
                <section className="import-repeat-group" key={group[0].group_id}>
                  <header><strong>Possible repeat {group[0].group_id}</strong><small>{group.length} {group.length === 1 ? "row" : "rows"}</small></header>
                  {repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup &&
                    <p className="muted">More rows in this group may be on the next page. Load them before deciding.</p>}
                  <ul className="import-repeats">
                    {group.map(row => (
                      <li key={row.row_no}>
                        <strong>{row.name || row.phone || row.email || "Row " + row.row_no}</strong>
                        <small>{[row.phone, row.email, row.address].filter(Boolean).join(" · ")}</small>
                        {row.match_lead && <Badge>{row.match_name ? "Already a lead: " + row.match_name : "Matches a lead"}</Badge>}
                      </li>
                    ))}
                  </ul>
                  <div className="import-repeat-actions">
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => act(() => api.imports.decide(job.id, { decisions: [{ group_id: group[0].group_id, action: "skip" }] }), "Repeat group left out.")}>Leave out</Button>
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => act(() => api.imports.decide(job.id, { decisions: [{ group_id: group[0].group_id, action: "import" }] }), "Repeat group kept as separate leads.")}>Keep separate</Button>
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => act(() => api.imports.decide(job.id, { decisions: [{ group_id: group[0].group_id, action: "merge" }] }), "Repeat group marked to merge.")}>Merge</Button>
                  </div>
                </section>
              ))}
            </div>
            {!repeats && <p className="muted">Loading possible repeats…</p>}
            {repeats && (repeatLimit < repeatGroups.length || repeats.rows.length < repeats.total) &&
              <Button disabled={loadingMore} onClick={showMoreRepeats}>{loadingMore ? "Loading…" : "Show more possible repeats"}</Button>}
            {repeats && <small className="muted">Showing {number(Math.min(repeats.rows.length, repeats.total))} of {number(repeats.total)} rows needing a decision.</small>}
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <div className="import-actions">
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "skip" }), "Remaining repeat groups left out.")}>
                Leave them out
              </Button>
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "import" }), "Remaining repeat groups kept as separate leads.")}>
                Keep all as separate leads
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "merge" }), "Remaining repeat groups marked to merge.")}>
                Merge repeats
              </Button>
            </div>
          </>
        )}

        {status === "ready" && (
          <>
            <p className="muted">Your list is ready to add to your leads.</p>
            <dl className="import-summary">
              <div>
                <dt>Rows in your file</dt>
                <dd>{number(report.source_rows)}</dd>
              </div>
              <div>
                <dt>Identical rows removed</dt>
                <dd>{number(report.exact_duplicates)}</dd>
              </div>
              <div>
                <dt>Identical rows already in CRM</dt>
                <dd>{number(report.exact_existing)}</dd>
              </div>
              <div>
                <dt>Rows with nothing usable</dt>
                <dd>{number((report.empty_rows || 0) + (report.unusable_rows || 0))}</dd>
              </div>
              <div>
                <dt>Columns not mapped to leads</dt>
                <dd>{number((report.dropped_columns || []).length)}</dd>
              </div>
              <div>
                <dt>Empty columns removed</dt>
                <dd>{number((report.empty_columns_removed || []).length)}</dd>
              </div>
            </dl>
            {error && (
              <p className="notice" role="alert">
                {error}
              </p>
            )}
            <div className="import-actions">
              <Button onClick={cancel}>Cancel import</Button>
              <Button variant="primary" disabled={busy} onClick={() => act(() => api.imports.merge(job.id), "Adding source rows to CRM leads.")}>
                Add to my leads
              </Button>
            </div>
          </>
        )}

        {status === "done" && (
          <>
            <p>
              {number(job.merged_rows)} rows were added or merged for <strong>{job.name}</strong>.
              {report.exact_existing > 0 && ` ${number(report.exact_existing)} identical rows were already in the CRM and linked automatically.`}
            </p>
            <div className="import-actions">
              <Button variant="primary" onClick={() => onClose(job)}>
                View source list
              </Button>
            </div>
          </>
        )}

        {(status === "failed" || status === "cancelled") && (
          <>
            <p role="alert">{job.error || (status === "cancelled" ? "This import was cancelled." : "This import could not be finished.")}</p>
            {status === "failed" && <p className="muted">Import ID: <code>{job.id}</code></p>}
            <div className="import-actions">
              <Button onClick={() => onClose(job)}>Back to source lists</Button>
              {status === "failed" && job.progress?.phase === "merging" && (
                <Button variant="primary" disabled={busy} onClick={() => act(() => api.imports.retry(job.id), "Adding stored source rows to CRM leads again.")}>
                  Retry adding leads
                </Button>
              )}
            </div>
          </>
        )}

        {error && !job && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
      </div>
  );
  return <>
    <Breadcrumb items={[{ label: "Source lists", path: "lists" }, ...(sourceListId ? [{ label: projectName || job?.name || "Source list", path: `lists/${sourceListId}` }] : []), { label: "Import" }]} />
    <PageHeader title={job?.name || projectName || name || "New source list"} description="Add and review rows for this source list." />
    <Card title={title} className="source-import-review">{content}</Card>
    {job?.id && job.status !== "cancelled" && <SourceRows jobs={[job]} navigate={navigate} />}
  </>;
}
