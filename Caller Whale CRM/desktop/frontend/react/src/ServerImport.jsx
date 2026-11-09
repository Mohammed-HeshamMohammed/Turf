import { useEffect, useRef, useState } from "react";
import { UploadSimple } from "@phosphor-icons/react";
import { api } from "./remote/api.ts";
import { IMPORT_FIELDS, follow, mappingBody, mappingProblem, uploadFile } from "./remote/imports.ts";
import { Badge, Button, Card, Checkbox, Field, Modal, Select } from "./ui.jsx";

// A list kept on Caller Whale's server (web CRM): sent in pieces, read and cleaned there, confirmed here, then added to the leads.
// Big lists take minutes, so closing this window does not stop anything; the list shows up under "Imports in progress" to continue.

const WORKING = {
  queued: "Waiting for its turn. One list is read at a time.",
  loading: "Reading your list",
  cleaning: "Tidying phone numbers, emails and addresses, and looking for repeats",
  merging: "Adding leads to your account",
  uploading: "Sending your list",
};
const number = (value) => Number(value || 0).toLocaleString();
const megabytes = (bytes) => (bytes / 1048576 >= 10 ? Math.round(bytes / 1048576).toLocaleString() : (bytes / 1048576).toFixed(1)) + " MB";

export function ServerImport({ resume = "", initialFile = null, inline = false, onClose, onFinished, onContinueInList }) {
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
  useEffect(() => () => stop.current.abort(), []);

  async function track(id) {
    try {
      const next = await follow(id, setJob, { signal: stop.current.signal });
      if (["reviewing", "ready"].includes(next.status) && onContinueInList && next.project_id) {
        onContinueInList(next);
        return;
      }
      if (next.status === "reviewing") setRepeats(await api.imports.duplicates(id));
      if (next.status === "done") onFinished?.(next);
    } catch (reason) {
      if (reason?.name !== "AbortError") setError(reason.message || "The server cannot be reached.");
    }
  }
  useEffect(() => {
    if (resume) void track(resume);
  }, [resume]);

  async function upload() {
    setError("");
    try {
      const queued = await uploadFile(file, {
        name: name.trim() || undefined,
        hasHeader: header,
        signal: stop.current.signal,
        onProgress: ({ sent: bytes, total, job: started }) => (setSent({ bytes, total }), setJob((current) => current ?? started)),
      });
      setSent(null);
      setJob(queued);
      await track(queued.id);
    } catch (reason) {
      if (reason?.name === "AbortError") return;
      setSent(null);
      setJob(null);
      setError(reason.message || "The list could not be sent.");
    }
  }

  async function act(work) {
    setBusy(true);
    setError("");
    try {
      const next = await work();
      setJob(next);
      await track(next.id);
    } catch (reason) {
      setError(reason.message || "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    stop.current.abort();
    stop.current = new AbortController();
    if (job) await api.imports.cancel(job.id).catch(() => {});
    onClose();
  }

  const status = job?.status;
  const working = sent || WORKING[status];
  const percent = sent
    ? Math.round((sent.bytes / sent.total) * 100)
    : status === "merging" && job.progress?.total
      ? Math.round((job.merged_rows / job.progress.total) * 100)
      : null;
  const columns = job?.columns ?? [];
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
  const content = (
      <div className="server-import">
        {!job && !sent && !resume && (
          <>
            <p className="muted">CSV, TXT, XLSX or XLS. Big lists are fine: they are sent in pieces and read on Caller Whale's server, one at a time.</p>
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
            <Field label="List name">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Austin owners" maxLength={200} />
            </Field>
            <Checkbox checked={header} onChange={(event) => setHeader(event.target.checked)} label="The first row names each column" />
            <div className="import-actions">
              <Button variant="primary" disabled={!file} onClick={upload}>
                Upload
              </Button>
            </div>
          </>
        )}
        {!job && resume && !error && <p className="muted">Loading this source list import…</p>}

        {working && (
          <div className="job-progress">
            <h3>{sent ? `Sending your list · ${percent}%` : working}</h3>
            {percent === null ? <progress aria-label="Working" /> : <progress value={percent} max="100" aria-label={`${percent} percent`} />}
            <p>
              {sent &&
                `${megabytes(sent.bytes)} of ${megabytes(sent.total)}. You can keep this window open or come back to it: nothing is lost if the connection drops.`}
              {!sent && status === "loading" && job.loaded_rows > 0 && `${number(job.loaded_rows)} rows read so far.`}
              {!sent && status === "cleaning" && job.progress?.done > 0 && `${number(job.progress.done)} rows tidied so far.`}
              {!sent && status === "merging" && `${number(job.merged_rows)} of ${number(job.progress?.total)} added. You can close this window; it carries on.`}
              {!sent && ["queued", "loading", "cleaning"].includes(status) && " You can close this window; it carries on and shows under Imports in progress."}
            </p>
            <Button onClick={cancel}>{status === "merging" ? "Stop adding" : "Cancel this import"}</Button>
          </div>
        )}

        {status === "mapping" && (
          <>
            <p className="muted">
              We matched what we could from the headings. Columns set to Not used stay in the source rows but are left out of your leads.
              {report.exact_duplicates > 0 && ` ${number(report.exact_duplicates)} identical rows were removed.`}
              {(report.empty_columns_removed || []).length > 0 && ` ${number(report.empty_columns_removed.length)} completely empty columns were removed from the source rows.`}
            </p>
            <div className="import-columns" role="table" aria-label="Columns in your list">
              {columns.map((column) => (
                <div className="import-column" role="row" key={column.idx}>
                  <div role="cell">
                    <strong>{column.header}</strong>
                    <small>{column.samples.length ? column.samples.slice(0, 2).join(" · ") : "Empty"}</small>
                    <small>
                      {number(column.populated)} of {number(report.rows)} rows filled
                    </small>
                  </div>
                  <div role="cell">
                    <Select
                      aria-label={`What ${column.header} is`}
                      value={(choices[column.idx] === undefined ? column.suggested : choices[column.idx]) || ""}
                      onChange={(event) =>
                        setChoices({
                          ...choices,
                          [column.idx]: event.target.value || null,
                        })
                      }
                    >
                      <option value="">Not used</option>
                      {IMPORT_FIELDS.map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
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
                onClick={() => act(() => api.imports.mapping(job.id, mappingBody(columns, choices)))}
              >
                Continue
              </Button>
            </div>
          </>
        )}

        {status === "reviewing" && (
          <>
            <p className="muted">
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
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => act(() => api.imports.decide(job.id, { decisions: [{ group_id: group[0].group_id, action: "skip" }] }))}>Leave out</Button>
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => act(() => api.imports.decide(job.id, { decisions: [{ group_id: group[0].group_id, action: "import" }] }))}>Keep separate</Button>
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => act(() => api.imports.decide(job.id, { decisions: [{ group_id: group[0].group_id, action: "merge" }] }))}>Merge</Button>
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
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "skip" }))}>
                Leave them out
              </Button>
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "import" }))}>
                Keep all as separate leads
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "merge" }))}>
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
              <Button variant="primary" disabled={busy} onClick={() => act(() => api.imports.merge(job.id))}>
                Add to my leads
              </Button>
            </div>
          </>
        )}

        {status === "done" && (
          <>
            <p>
              {number(job.merged_rows)} rows were added to <strong>{job.name}</strong>. They appear in your leads as they arrive.
            </p>
            <div className="import-actions">
              <Button variant="primary" onClick={onClose}>
                {inline ? "View source list" : "Done"}
              </Button>
            </div>
          </>
        )}

        {(status === "failed" || status === "cancelled") && (
          <>
            <p role="alert">{job.error || (status === "cancelled" ? "This import was cancelled." : "This import could not be finished.")}</p>
            {status === "failed" && <p className="muted">Import ID: <code>{job.id}</code></p>}
            <div className="import-actions">
              <Button onClick={onClose}>Close</Button>
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
  return inline
    ? <Card title={title} subtitle={job?.name ? `Importing into ${job.name}` : undefined} className="source-import-review">{content}</Card>
    : <Modal title={title} onClose={status === "uploading" || sent ? cancel : onClose}>{content}</Modal>;
}
