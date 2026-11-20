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
  queued: "Waiting for a free worker. Several lists are read at the same time.",
  loading: "Reading your list",
  cleaning: "Tidying phone numbers, emails and addresses, and looking for repeats",
  merging: "Adding leads to your account",
  uploading: "Sending your list",
};
const number = (value) => Number(value || 0).toLocaleString();
const PHASES = { loading: "reading", cleaning: "tidying", matching: "looking for repeats" };

/** One row of a possible repeat, complete: every column of the file that has something in it, with the values that differ from the other rows
 *  of the group marked, so two rows can be told apart at a glance. */
function RepeatRow({ row, group, columns }) {
  const same = (a, b) => String(a || "").trim().toLowerCase().replace(/\s+/g, " ") === String(b || "").trim().toLowerCase().replace(/\s+/g, " ");
  const cells = row.cells || [];
  const shown = columns.map((column, i) => ({ column, value: cells[column.idx ?? i] })).filter(item => String(item.value || "").trim());
  return (
    <li>
      <strong>{row.name || row.phone || row.email || "Row " + row.row_no}</strong>
      {shown.length ? (
        <dl className="repeat-cells">
          {shown.map(({ column, value }) => {
            const differs = group.some(other => other !== row && !same((other.cells || [])[column.idx], value));
            return (
              <div key={column.idx} className={differs ? "differs" : ""}>
                <dt>{column.header}</dt>
                <dd>{value}</dd>
              </div>
            );
          })}
        </dl>
      ) : (
        <small>{[row.phone, row.email, row.address].filter(Boolean).join(" · ")}</small>
      )}
      {row.match_lead && (
        <div className="repeat-lead">
          <Badge>{row.match_name ? "Already a lead: " + row.match_name : "Matches a lead"}</Badge>
          <small>{[row.match_phone, row.match_email, [row.match_address, row.match_city, row.match_zip].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}</small>
          {row.match_name && !same(row.name, row.match_name) && <small>The name is different. Only a phone number or email is the same: is this the same person?</small>}
        </div>
      )}
    </li>
  );
}

const CLEARED = {
  phone: "Phone cells that were not a phone number",
  phone_made_up: "Phone numbers that do not exist (an area code nobody has, or made up like 5555555555), left out",
  email: "Emails that were not valid, left out",
  value: "Values that were not a number, left out",
  latitude: "Latitudes outside the map, left out",
  longitude: "Longitudes outside the map, left out",
};

/** The rows behind one count: what was in the cell and could not be used, with a file of them to fix and send again. */
function ClearedRows({ jobId, field, label }) {
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState("");
  async function load(offset) {
    setBusy(true);
    setFailed("");
    try {
      const next = await api.imports.cleared(jobId, field, offset);
      setPage(current => (offset && current ? { ...next, rows: [...current.rows, ...next.rows] } : next));
    } catch (reason) {
      setFailed(reason.message || "The rows could not be loaded.");
    } finally {
      setBusy(false);
    }
  }
  function download() {
    const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [["Row", "Name", ...page.headers], ...page.rows.map(row => [row.row_no, row.name, ...row.values])].map(line => line.map(quote).join(","));
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\r\n")], { type: "text/csv" }));
    link.download = `${field}-rows.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
  if (!page) return <Button disabled={busy} onClick={() => load(0)}>{busy ? "Loading…" : "Show the rows"}</Button>;
  return (
    <div className="cleared-rows">
      <p className="muted">{label}: {number(page.total)} {page.total === 1 ? "row" : "rows"}. The row number is the row's place in your file.</p>
      <ul className="import-repeats">
        {page.rows.map(row => (
          <li key={row.row_no}>
            <strong>Row {number(row.row_no)}{row.name ? ` · ${row.name}` : ""}</strong>
            <small>{page.headers.map((header, i) => (row.values[i] ? `${header}: ${row.values[i]}` : "")).filter(Boolean).join(" · ")}</small>
          </li>
        ))}
      </ul>
      {failed && <p className="notice" role="alert">{failed}</p>}
      <div className="import-actions">
        {page.rows.length < page.total && <Button disabled={busy} onClick={() => load(page.rows.length)}>{busy ? "Loading…" : "Show more"}</Button>}
        <Button onClick={download}>Download these rows</Button>
        <Button onClick={() => setPage(null)}>Hide</Button>
      </div>
    </div>
  );
}

/** What the tidying did to the data, in counts: cells it could not use, sheets it did not read, mobile and landline numbers. */
function CleaningNotes({ report, jobId }) {
  const cleared = Object.entries(report.cleared_cells || {});
  const types = report.line_types;
  if (!cleared.length && !(report.other_sheets || []).length && !types) return null;
  return (
    <div className="cleaning-notes">
      {(report.other_sheets || []).length > 0 && (
        <p className="muted">Only one sheet of this workbook was read. Not imported: {report.other_sheets.join(", ")}.</p>
      )}
      {cleared.length > 0 && (
        <dl className="import-summary">
          {cleared.map(([key, count]) => (
            <div key={key}>
              <dt>{CLEARED[key] || key}</dt>
              <dd>{number(count)}</dd>
            </div>
          ))}
        </dl>
      )}
      {jobId && cleared.map(([key]) => <ClearedRows key={key} jobId={jobId} field={key} label={CLEARED[key] || key} />)}
      {types === "unavailable" && <p className="muted">Mobile and landline numbers could not be checked this time. The list was tidied without it.</p>}
      {types && types !== "unavailable" && (
        <p className="muted">Phone line types: {Object.entries(types).map(([kind, count]) => `${kind} ${number(count)}`).join(" · ")}.</p>
      )}
    </div>
  );
}

/** What a waiting import is waiting for: how many lists are ahead, the one being worked on, and, if it has gone quiet, a way to stop it. */
function QueueNote({ queue, onStopFront, stopping }) {
  if (!queue || !queue.ahead) return null;
  const front = queue.running;
  const quiet = front && front.idle_seconds > 180;
  return (
    <div className="queue-note">
      <p>
        <strong>{queue.ahead === 1 ? "1 list is" : `${queue.ahead} lists are`} ahead of yours.</strong>
        {front?.other_workspace && " One from another workspace is being read."}
        {front?.name &&
          ` Now ${PHASES[front.phase || front.status] || "working on"} “${front.name}”${front.total ? `: ${number(front.done || 0)} of ${number(front.total)} rows` : ""}${front.step ? ` (${front.step})` : ""}.`}
      </p>
      {quiet && (
        <p>
          {front.name ? "That import" : "The list in front"} has not reported for {Math.round(front.idle_seconds / 60)} minutes and may be stuck.
          {front.id && (
            <>
              {" "}
              <Button disabled={stopping} onClick={() => onStopFront(front.id)}>
                {stopping ? "Stopping…" : "Stop that import"}
              </Button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
/** Until when the uploaded file is kept; the person is always told that it is deleted after. */
function FileKept({ report }) {
  if (!report.file_kept_until) return null;
  const day = new Date(report.file_kept_until + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return <p className="muted">The file you uploaded is kept until {day} and is then deleted. Only the columns you keep are stored in this list.</p>;
}
const megabytes = (bytes) => (bytes / 1048576 >= 10 ? Math.round(bytes / 1048576).toLocaleString() : (bytes / 1048576).toFixed(1)) + " MB";

export function ServerImport({ resume = "", initialFile = null, projectId = null, projectName = "", onClose, onFinished, onStarted }) {
  const { navigate, notify, refreshImports } = useCrm();
  const [file, setFile] = useState(initialFile);
  const [name, setName] = useState(initialFile ? initialFile.name.replace(/\.[^.]+$/, "") : "");
  const [header, setHeader] = useState(true);
  const [skipTracing, setSkipTracing] = useState(false);
  const [job, setJob] = useState(null);
  const [sent, setSent] = useState(null);
  const [error, setError] = useState("");
  const [choices, setChoices] = useState({});
  const [repeats, setRepeats] = useState(null);
  const [picking, setPicking] = useState(null);
  const [repeatLimit, setRepeatLimit] = useState(12);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [merges, setMerges] = useState(null);
  const [keepLast, setKeepLast] = useState(false);
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
      if (next.status === "ready") setPreview(await api.imports.preview(id).catch(() => null));
      if (next.status === "done") {
        setMerges(await api.imports.merges(id).catch(() => null));
        onFinished?.(next);
      }
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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- resume once per import; track is redefined each render
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
        skipTracing,
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

  // Back to "What is in each column?": the rows loaded so far are dropped and the kept file is read again, with the last answers remembered.
  function chooseColumnsAgain() {
    setChoices({});
    setRepeats(null);
    setPreview(null);
    return act(() => api.imports.columnsAgain(job.id), "Reading the list again. Your last answers are remembered.");
  }

  async function undoMerge(row) {
    setBusy(true);
    try {
      await api.imports.undoMerge(job.id, row.row_no);
      notify(`${row.name || "That row"} is now a lead of its own.`);
      setMerges(await api.imports.merges(job.id));
      void refreshImports?.().catch(() => {});
    } catch (reason) {
      setError(reason.message || "That merge could not be undone.");
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
      : status === "cleaning" && typeof job.progress?.pct === "number"
        ? Math.min(99, job.progress.pct)
        : null;
  // The steps after the tidying compare rows with each other and with the leads already in the account; the worker says which one it is on.
  const matching = status === "cleaning" && job?.progress?.phase === "matching";
  // How long the tidying has been going and how much is left, worked out from the worker's percentage as it moves.
  const clock = useRef({ id: null, since: 0, from: 0 });
  const working_pct = status === "cleaning" && typeof job?.progress?.pct === "number" ? job.progress.pct : null;
  if (working_pct === null) clock.current = { id: null, since: 0, from: 0 };
  else if (clock.current.id !== job.id) clock.current = { id: job.id, since: Date.now(), from: working_pct };
  const seconds = working_pct === null ? 0 : Math.round((Date.now() - clock.current.since) / 1000);
  const moved = working_pct === null ? 0 : working_pct - clock.current.from;
  const remaining = moved >= 4 && seconds >= 10 ? Math.round((seconds / moved) * (100 - working_pct)) : null;
  const minutes = (secs) => (secs < 90 ? `${Math.max(5, Math.round(secs / 5) * 5)} seconds` : `${Math.round(secs / 60)} minutes`);
  const [stopping, setStopping] = useState(false);
  async function stopFront(frontId) {
    setStopping(true);
    try {
      await api.imports.cancel(frontId);
      notify("Stopped. Your list moves up.");
      void refreshImports?.().catch(() => {});
    } catch (reason) {
      notify(reason.message || "That import could not be stopped.");
    }
    setStopping(false);
  }
  const columns = job?.columns ?? [];
  const knownFields = new Set([...IMPORT_FIELDS, ...SOURCE_IMPORT_FIELDS].map(([key]) => key));
  const additionalFields = [...new Map(columns.filter(column => column.source_detail && column.standard_key && !knownFields.has(column.standard_key))
    .map(column => [column.standard_key, [column.standard_key, column.source_detail]])).values()];
  const problem = status === "mapping" ? mappingProblem(columns, choices, Boolean(job?.for_skip_tracing)) : "";
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
            {!canResumeUpload && <p className="muted">The file you upload is kept on Caller Whale's server for a limited time and is then deleted. You are shown the date once it has been read.</p>}
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
            {!canResumeUpload && <p className="muted">Starting a list from nothing? <a className="text-link" href="/caller-whale-list-template.csv" download>Download a template</a> with the headings Caller Whale recognises.</p>}
            {!canResumeUpload && <Field label="List name">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Austin owners" maxLength={200} />
            </Field>}
            {!canResumeUpload && <Checkbox checked={header} onChange={(event) => setHeader(event.target.checked)} label="The first row names each column" />}
            {!canResumeUpload && <Checkbox checked={skipTracing} onChange={(event) => setSkipTracing(event.target.checked)} label="This list is for skip tracing: it has addresses but no phone numbers or emails yet" />}
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
            <h3>{sent ? `Sending your list · ${percent}%` : status === "cleaning" ? (matching ? job.progress.step : "Tidying phone numbers, emails and addresses") : working}{status === "cleaning" && percent !== null ? ` · ${percent}%` : ""}</h3>
            <LiquidProgress value={percent} label={percent === null ? "Working" : `${percent} percent`} />
            <p>
              {sent &&
                `${megabytes(sent.bytes)} of ${megabytes(sent.total)}. You can leave this page and resume with the same file if the connection drops.`}
              {!sent && status === "loading" && job.loaded_rows > 0 && `${number(job.loaded_rows)} rows read so far.`}
              {!sent && status === "cleaning" && !matching && `${number(job.progress?.done)} of ${number(job.progress?.total || job.loaded_rows)} rows tidied.`}
              {!sent && matching && job.progress.total > 0 && `${number(job.progress.done)} of ${number(job.progress.total)} rows checked.`}
              {!sent && matching && job.progress.existing_leads > 0 && ` ${number(job.progress.existing_leads)} leads already in your account to compare with.`}
              {!sent && matching && job.progress.found > 0 && ` ${number(job.progress.found)} possible repeats found so far.`}
              {!sent && status === "cleaning" && ` Running for ${seconds < 90 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`}${remaining !== null ? `, about ${minutes(remaining)} to go` : ""}.`}
              {!sent && status === "merging" && `${number(job.merged_rows)} of ${number(job.progress?.total)} added. You can leave this page; it carries on.`}
              {!sent && ["queued", "loading", "cleaning"].includes(status) && " You can leave this page; processing carries on in the background."}
            </p>
            {!sent && status === "queued" && <QueueNote queue={job.queue} onStopFront={stopFront} stopping={stopping} />}
            <Button onClick={cancel}>{status === "merging" ? "Stop adding" : "Cancel this import"}</Button>
          </div>
        )}

        {status === "mapping" && (
          <>
            <p className="muted">
              {number(columns.filter(column => column.standard_key).length)} of {number(columns.length)} remaining columns recognized. Source fields keep their original values in this list; recognized property details also appear on new properties.
              {(report.empty_columns_removed || []).length > 0 && ` ${number(report.empty_columns_removed.length)} completely empty columns were removed from the source rows.`}
            </p>
            {(report.other_sheets || []).length > 0 && <p className="muted">Only one sheet of this workbook was read. Not imported: {report.other_sheets.join(", ")}.</p>}
            {report.relatives_left_out > 0 && <p className="muted">{number(report.relatives_left_out)} columns about the owner's relatives were left out: that data is often wrong and is not the lead.</p>}
            <p className="muted">Columns you set to "Not used" are not stored in this list.</p>
            <FileKept report={report} />
            <div className="import-columns" role="table" aria-label="Columns in your list">
              {columns.map((column) => (
                <div className="import-column" role="row" key={column.idx}>
                  <div role="cell">
                    <strong>{column.header}</strong>
                    {column.source_detail && <small>Recognized as {column.source_detail} · saved in source rows</small>}
                    {column.remembered === "used" && <small>Same as your last list with this heading</small>}
                    {column.remembered === "unused" && <small>You left this out last time</small>}
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
                      <option value="">Not used (not stored)</option>
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
              {report.identical_merged > 0 && `${number(report.identical_merged)} rows that were exactly the same as another were merged. `}
              {report.certain_matches_merged > 0 && `${number(report.certain_matches_merged)} rows that match a lead you already have on everything were merged into it. `}
              {number(report.near_groups)} {report.near_groups === 1 ? "group may contain" : "groups may contain"} repeat leads.
              The name and the property are the same, or the names are nearly the same, along with a phone number, email or address; the rows are not exactly the same (those were merged for you). The same owner with another property is a separate lead and is not listed. Whole rows are shown, with what differs marked.
            </p>
            <div className="import-repeat-groups">
              {repeatGroups.slice(0, repeatLimit).map(group => (
                <section className="import-repeat-group" key={group[0].group_id}>
                  <header><strong>Possible repeat {group[0].group_id}</strong><small>{group.length} {group.length === 1 ? "row" : "rows"}</small></header>
                  {repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup &&
                    <p className="muted">More rows in this group may be on the next page. Load them before deciding.</p>}
                  <ul className="import-repeats">
                    {group.map(row => (
                      <RepeatRow key={row.row_no} row={row} group={group} columns={columns} />
                    ))}
                  </ul>
                  {maybeCoOwners(group) &&
                    <p className="muted"><Badge tone="info">Possible co-owners</Badge> Same property, different names. Choose Keep separate: each stays its own lead, linked to the others at this property.</p>}
                  {picking === group[0].group_id &&
                    <FieldPicker group={group} busy={busy} onCancel={() => setPicking(null)}
                      onMerge={pick => act(() => api.imports.decide(job.id, { picks: [pick] }), "Repeat group merged with the fields you chose.").then(() => setPicking(null))} />}
                  <div className="import-repeat-actions">
                    <Button disabled={busy || (repeats.rows.length < repeats.total && group[0].group_id === lastLoadedGroup)} onClick={() => setPicking(current => current === group[0].group_id ? null : group[0].group_id)}>Choose fields</Button>
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
            <Checkbox checked={keepLast} onChange={(event) => setKeepLast(event.target.checked)} label="When repeats are merged, keep the last row of each group instead of the first" />
            <div className="import-actions">
              <Button disabled={busy} onClick={chooseColumnsAgain}>Choose the columns again</Button>
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "merge", only: "existing", keep: keepLast ? "last" : "first" }), "Matches with leads you already have marked to merge.")}>
                Merge only those matching my leads
              </Button>
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "import", only: "inside" }), "Repeats inside this list kept as separate leads.")}>
                Keep repeats inside the list separate
              </Button>
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "skip" }), "Remaining repeat groups left out.")}>
                Leave them out
              </Button>
              <Button disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "import" }), "Remaining repeat groups kept as separate leads.")}>
                Keep all as separate leads
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => act(() => api.imports.decide(job.id, { all: "merge", keep: keepLast ? "last" : "first" }), "Remaining repeat groups marked to merge.")}>
                Merge repeats
              </Button>
            </div>
          </>
        )}

        {status === "ready" && (
          <>
            <p className="muted">Your list is ready to add to your leads.</p>
            {preview?.counts && (
              <div className="import-preview">
                <p>
                  <strong>{number(preview.counts.new_leads)}</strong> new {preview.counts.new_leads === 1 ? "lead" : "leads"} will be added.{" "}
                  {number(preview.counts.fill_existing)} {preview.counts.fill_existing === 1 ? "row fills" : "rows fill"} gaps in leads you already have.{" "}
                  {number(preview.counts.left_out)} {preview.counts.left_out === 1 ? "row is" : "rows are"} left out.
                </p>
                {(preview.new_sample || []).length > 0 && (
                  <small className="muted">First new leads: {preview.new_sample.map((row) => row.name || row.phone || row.email || `Row ${row.row_no}`).join(" · ")}</small>
                )}
                {(preview.fill_sample || []).length > 0 && (
                  <small className="muted">
                    Adds to: {preview.fill_sample.map((row) => `${row.lead_name || "a lead"} (${(row.would_fill || []).join(" and ") || "nothing new"})`).join(" · ")}
                  </small>
                )}
              </div>
            )}
            <CleaningNotes report={report} jobId={job.id} />
            <FileKept report={report} />
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
              <Button disabled={busy} onClick={chooseColumnsAgain}>Choose the columns again</Button>
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
            <FileKept report={report} />
            {(merges?.rows || []).length > 0 && (
              <div className="merge-log">
                <h3>Rows added to leads you already had</h3>
                <p className="muted">If one of these was not the same person, undo it: what it filled in is removed and the row becomes a lead of its own.</p>
                <ul className="import-repeats">
                  {merges.rows.map((row) => (
                    <li key={row.row_no}>
                      <strong>{row.name || row.phone || row.email || `Row ${row.row_no}`}</strong>
                      <small>
                        into {row.lead_name || "a lead"}
                        {(row.filled || []).length > 0 ? ` · filled in ${row.filled.join(" and ")}` : " · nothing new to fill"}
                      </small>
                      <Button disabled={busy} onClick={() => undoMerge(row)}>Undo</Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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

const PICK_FIELDS = [["name", "Name"], ["phone", "Phone"], ["email", "Email"], ["address", "Address"], ["city", "City"], ["zip", "ZIP"]];
const sameName = value => String(value || "").toLowerCase().replace(/[^a-z]/g, "");

/** Rows at one address under names that are not the same person: likely co-owners (siblings, spouses, heirs), not a repeat. */
export function maybeCoOwners(group) {
  const names = new Set(group.flatMap(row => [row.name, row.match_lead ? row.match_name : null]).filter(Boolean).map(sameName));
  const addresses = new Set(group.flatMap(row => [row.address, row.match_lead ? row.match_address : null]).filter(Boolean).map(sameName));
  return names.size > 1 && addresses.size === 1 && [...names].every(name => [...names].every(other => name === other || !(name.includes(other) || other.includes(name))));
}

/** Merging one repeat group field by field: for each field, which row's value the lead keeps (or what the lead in your CRM already
 * has). Every phone and email of the group can be kept among the lead's contacts. */
export function FieldPicker({ group, busy, onMerge, onCancel }) {
  const lead = group.find(row => row.match_lead);
  const sources = [...(lead ? [{ key: "lead", label: "In your CRM", value: field => lead["match_" + field] }] : []),
    ...group.map(row => ({ key: row.row_no, label: `Row ${number(row.row_no)}`, value: field => row[field] }))];
  const [fields, setFields] = useState(() => Object.fromEntries(PICK_FIELDS.map(([field]) => [field, sources.find(source => source.value(field))?.key ?? sources[0].key])));
  const [keepAll, setKeepAll] = useState(true);
  return (
    <div className="import-field-picker">
      <table>
        <thead>
          <tr><th scope="col">Field</th>{sources.map(source => <th scope="col" key={source.key}>{source.label}</th>)}</tr>
        </thead>
        <tbody>
          {PICK_FIELDS.map(([field, label]) => (
            <tr key={field}>
              <th scope="row">{label}</th>
              {sources.map(source => (
                <td key={source.key}>
                  <label className="import-pick">
                    <input type="radio" name={`pick-${group[0].group_id}-${field}`} checked={fields[field] === source.key}
                      onChange={() => setFields(current => ({ ...current, [field]: source.key }))} />
                    <span>{source.value(field) || <em className="muted">empty</em>}</span>
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <Checkbox checked={keepAll} onChange={event => setKeepAll(event.target.checked)} label="Keep every phone and email of these rows on the lead" />
      <div className="import-repeat-actions">
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button variant="primary" disabled={busy} onClick={() => onMerge({ group_id: group[0].group_id, fields, keep_all: keepAll })}>Merge with these</Button>
      </div>
    </div>
  );
}
