import { useEffect, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { ArrowRight, ArrowUpRight, CheckCircle, Phone, Cloud, DownloadSimple, FileCsv, HardDrives, ShieldCheck, UploadSimple } from "@phosphor-icons/react";
import { LEAD_STAGES, ROLES } from "./data.js";
import { capability, uid, visibleLeads } from "./model.js";
import { useCrm } from "./context.jsx";
import { detectSourceFields, leadFromSource, sourceEvidence, sourceValue } from "./skiptrace-fields.js";
import { SourceFieldMapping } from "./SourceFieldMapping.jsx";
import { PropertyMap } from "./PropertyMap.jsx";
import { LeadsMap } from "./LeadsMap.jsx";
import { cancelJob, check, checkRepeats, engineAvailable, engineConfig, prepare, saveCopy } from "./engine.js";
import { api } from "./remote/api.js";
import {
  Badge,
  Select,
  Button,
  Card,
  Checkbox,
  Empty,
  Field,
  LeadLink,
  PageHeader,
  Search,
  Segmented,
  DataTable,
  Status,
  useShowMore,
  downloadCsv,
  Breadcrumb,
  useTableView,
} from "./ui.jsx";

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export function Lists({ id }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState("");
  const input = useRef(null);
  const leads = visibleLeads(state);
  const listLeads = useMemo(() => leads.filter(lead => lead.datasetId === id), [leads, id]);
  const datasetIds = new Set(leads.map(item => item.datasetId));
  const datasets = state.datasets.filter(item => datasetIds.has(item.id) || (capability(state, "import") && item.team === (ROLES[state.role].team || "Tampa")));
  const dataset = datasets.find(item => item.id === id);
  const table = useTableView(
    leads.filter(lead => lead.datasetId === id),
    {
      owner: { value: lead => lead.name },
      property: { value: lead => lead.address },
      phone: { value: lead => lead.phone || "￿" },
      quality: { value: lead => lead.verdict || "" },
      stage: { value: lead => LEAD_STAGES.indexOf(lead.stage) },
    },
    "source-list",
  );
  function importRows(rows, name, columns) {
    if (!rows.length) {
      setError("The CSV has no data rows. Choose a file with a header and at least one record.");
      return;
    }
    const datasetId = uid();
    const fieldMappings = detectSourceFields(
      columns,
      rows.map(row => ({ sourceValues: row })),
    );
    const imported = rows.map((row, index) => {
      const data = leadFromSource(columns, { sourceValues: row }, fieldMappings);
      return {
        ...data,
        id: uid(),
        datasetId,
        sourceValues: row,
        name: data.name || "Imported owner " + (index + 1),
        address: data.address || "Address not supplied",
        stage: "New",
        assignee: "Unassigned",
        team: ROLES[state.role].team || "Tampa",
        callback: "",
        callbackDate: "",
        calls: [],
        source: "CSV import",
        verdict: "Unverified",
        shared: false,
        version: 1,
        priority: "Normal",
        notes: [],
        motivation: "Imported from " + name + ". Review source fields before outreach.",
      };
    });
    dispatch({
      type: "IMPORT",
      dataset: {
        id: datasetId,
        name,
        description: "CSV import · " + rows.length.toLocaleString() + " rows",
        status: "Not checked",
        team: ROLES[state.role].team || "Tampa",
        date: "Oct 15",
        columns,
        fieldMappings,
      },
      leads: imported,
    });
    setError("");
    notify("Imported " + imported.length.toLocaleString() + " rows from " + name);
    navigate("lists/" + datasetId);
  }
  async function readFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Choose a CSV file. Save a spreadsheet as CSV first.");
      return;
    }
    // The same ceiling as the Skip Tracing engine; a list this size is a few hundred thousand rows.
    if (file.size > MAX_IMPORT_BYTES) {
      setError("This file is over 50 MB. Split it into smaller CSV files and import each one.");
      return;
    }
    setReading(file.name);
    // Let the "Reading…" note paint before a large file keeps the page busy.
    await new Promise(resolve => setTimeout(resolve, 30));
    try {
      const result = Papa.parse(await file.text(), { header: true, skipEmptyLines: "greedy" });
      if (result.errors.length) {
        setError("CSV could not be read: " + result.errors[0].message);
        return;
      }
      if (!result.data.length) {
        setError("This CSV has a header row but no data rows.");
        return;
      }
      importRows(result.data, file.name.replace(/\.csv$/i, ""), result.meta.fields || []);
    } catch {
      setError("The file could not be read. Try another CSV.");
    } finally {
      setReading("");
    }
  }
  const sample = () =>
    importRows(
      [
        { Owner: "Casey Miller", Address: "340 Palm Court", City: "Tampa", Phone: "+1 (813) 555-0194", Email: "casey@example.com" },
        { Owner: "Jamie Reed", Address: "221 Pine Lane", City: "Tampa", Phone: "+1 (813) 555-0195", Email: "jamie@example.com" },
      ],
      "Tampa new opportunities",
      ["Owner", "Address", "City", "Phone", "Email"],
    );
  if (id && !dataset) return <Empty title="This list is outside your view">Return to the lists available to your role.</Empty>;
  if (dataset)
    return (
      <>
        <Breadcrumb items={[{ label: "Lists", path: "lists" }, { label: dataset.name }]} />
        <PageHeader
          title={dataset.name}
          description={leads.filter(lead => lead.datasetId === id).length + " visible records · original source kept separate from CRM changes."}
        >
          {capability(state, "export") && (
            <Button
              icon={DownloadSimple}
              onClick={() =>
                downloadCsv(exportName(dataset.name, "export"), [
                  [...dataset.columns, "CRM stage"],
                  ...leads.filter(lead => lead.datasetId === id).map(lead => [...dataset.columns.map(column => sourceValue(lead, column)), lead.stage]),
                ])
              }
            >
              Export view
            </Button>
          )}
          {capability(state, "call") && (
            <Button icon={Phone} onClick={() => navigate("work/calls?list=" + id)}>
              Call this list
            </Button>
          )}
          {(capability(state, "review") || capability(state, "import")) && (
            <Button variant="primary" icon={ShieldCheck} onClick={() => navigate("skip?list=" + id)}>
              Open in Skip Tracing
            </Button>
          )}
        </PageHeader>
        <div className="list-context">
          <Status value={dataset.status} />
          <Badge>{dataset.team} project</Badge>
          <span>Fields: {dataset.columns.join(" · ")}</span>
        </div>
        <LeadsMap leads={listLeads} />
        <Card className="table-card">
          <DataTable
            view={table}
            rowKey={lead => lead.id}
            columns={[
              { id: "owner", label: "Owner", cell: lead => <LeadLink lead={lead} detail={false} /> },
              {
                id: "property",
                label: "Property",
                cell: lead => (
                  <>
                    {lead.address}
                    <small>
                      {lead.city}, {lead.region}
                    </small>
                  </>
                ),
              },
              { id: "phone", label: "Best phone", cell: lead => lead.phone || <span className="muted">No phone supplied</span> },
              { id: "quality", label: "Quality", cell: lead => <Status value={lead.verdict} /> },
              { id: "stage", label: "CRM stage", cell: lead => <Status value={lead.stage} /> },
            ]}
            trailing={{
              head: <span className="sr-only">Open</span>,
              cell: lead => (
                <Button onClick={() => navigate("work/leads/" + lead.id)}>
                  Open lead <ArrowUpRight size={14} />
                </Button>
              ),
            }}
          />
        </Card>
      </>
    );
  return (
    <>
      <PageHeader title="Source lists" description="Imported lists and the leads that came from them.">
        {capability(state, "import") && (
          <Button variant="primary" icon={UploadSimple} onClick={() => input.current.click()}>
            Import CSV
          </Button>
        )}
      </PageHeader>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        hidden
        onChange={event => {
          void readFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div className="filter-bar">
        <Search value={search} onChange={setSearch} placeholder="Search lists" />
        <span className="result-count">{datasets.length} source lists</span>
      </div>
      <div className="dataset-grid">
        {datasets
          .filter(item => item.name.toLowerCase().includes(search.toLowerCase()))
          .map(item => (
            <Card key={item.id} className="dataset-card">
              <div className="dataset-top">
                <span className="file-icon">
                  <FileCsv size={27} weight="light" />
                </span>
                <RoundList item={item} navigate={navigate} />
              </div>
              <h2>{item.name}</h2>
              <p className="muted">{item.description}</p>
              <div className="dataset-count">
                {leads.filter(lead => lead.datasetId === item.id).length}
                <small>visible records</small>
              </div>
              <div className="row">
                <Status value={item.status} />
                <small>{item.date}</small>
              </div>
              <footer>
                <Badge>{item.team}</Badge>
                <Button onClick={() => navigate("lists/" + item.id)}>
                  Open list <ArrowRight size={16} />
                </Button>
              </footer>
            </Card>
          ))}
      </div>
      {capability(state, "import") && (
        <div
          className="import-zone"
          onDragOver={event => event.preventDefault()}
          onDrop={event => {
            event.preventDefault();
            void readFile(event.dataTransfer.files?.[0]);
          }}
        >
          <UploadSimple size={28} weight="light" />
          <h3>Bring in your next opportunity list.</h3>
          <p>Drop a CSV here, or choose a file. Imported lists are kept on this device.</p>
          <div className="row">
            <Button onClick={() => input.current.click()}>Choose CSV</Button>
            <Button onClick={sample}>Try a sample import</Button>
          </div>
          <small>{reading ? "Reading " + reading + "…" : "CSV files up to 50 MB · every row is imported"}</small>
        </div>
      )}
    </>
  );
}
function RoundList({ item, navigate }) {
  return (
    <button className="round-button" aria-label={"Open " + item.name} onClick={() => navigate("lists/" + item.id)}>
      <ArrowUpRight size={20} />
    </button>
  );
}

const OUTCOME_NAMES = {
  reached: "Contacted",
  wrong_number: "Wrong number",
  wrong_person: "Wrong person",
  disconnected: "Disconnected",
  do_not_call: "Do not call",
  no_answer: "No answer",
};

const STAGE_LABELS = {
  reading_file: "Reading source rows",
  gathering_outcomes: "Gathering known call outcomes",
  checking_phones: "Checking phone numbers",
  finding_duplicates: "Finding repeated leads",
  saving_checked_copy: "Saving the checked copy",
};

const yes = value => (value ? "Yes" : "");
const OWNER_COLUMNS = ["Owner properties in list", "All owner property addresses", "Absentee", "Out of state", "Vacant", "Score", "Score why"];
const ownerCells = result => [
  result?.properties || 1,
  result?.addresses || "",
  yes(result?.absentee),
  yes(result?.outOfState),
  yes(result?.vacant),
  result?.score ?? "",
  (result?.reasons || []).join("; "),
];

/** One row per owner, best score first: the owner's first row, with every property they hold in the list. Public
 * owners (a housing authority, a city) are left out; repeats of one property count once. */
function ownerRows(columns, rows, results) {
  const seen = new Set();
  // Best score first, so each owner is shown by their most promising property.
  return rows
    .map((lead, index) => ({ lead, index, result: results[index] || {} }))
    .filter(({ result }) => !result.government && !String(result.duplicate || "").startsWith("Duplicate"))
    .sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0) || a.index - b.index)
    .filter(({ result, index }) => {
      const key = result.owner || "row" + index;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(({ lead, result }) => [...columns.map(column => sourceValue(lead, column)), ...ownerCells(result)]);
}

const exportName = (list, what) => `${String(list || "turf list").replace(/\.[a-z0-9]{2,4}$/i, "")} (${what}).csv`;

export function SkipTracing() {
  const { state, dispatch, navigate, notify, route } = useCrm();
  const leads = visibleLeads(state);
  const ids = new Set(leads.map(lead => lead.datasetId));
  const datasets = state.datasets.filter(item => ids.has(item.id));
  const [datasetId, setDatasetId] = useState(new URLSearchParams(route.split("?")[1]).get("list") || datasets[0]?.id || "");
  const [mode, setMode] = useState("Local");
  const [step, setStep] = useState(0);
  const [hideEmpty, setHideEmpty] = useState(false);
  const [fieldOverrides, setFieldOverrides] = useState({});
  const [signals, setSignals] = useState({ duplicates: true, outcomes: true, dnc: true, age: true });
  const [region, setRegion] = useState("US");
  // The real engine when it can be reached (desktop window, dev server); the demo check otherwise (hosted demo).
  const [engine, setEngine] = useState(null);
  const [statuses, setStatuses] = useState(null);
  const [progress, setProgress] = useState(null);
  const [checked, setChecked] = useState(null);
  const [error, setError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const running = useRef(null);
  const timers = useRef([]);
  const stepNavigation = useRef(null);
  useEffect(() => {
    let live = true;
    engineAvailable().then(value => live && setEngine(value));
    return () => {
      live = false;
      timers.current.forEach(clearTimeout);
      running.current?.abort();
    };
  }, []);
  const dataset = datasets.find(item => item.id === datasetId);
  // Worked out again only when the list, its rows or the mapping change, not on every render: a list can hold tens of
  // thousands of rows.
  const rows = useMemo(() => leads.filter(lead => lead.datasetId === datasetId), [leads, datasetId]);
  const columns = useMemo(() => dataset?.columns || [], [dataset]);
  const shownColumns = hideEmpty ? columns.filter(column => rows.some(row => String(sourceValue(row, column) ?? "").trim())) : columns;
  const mappingsKey = JSON.stringify({ ...dataset?.fieldMappings, ...fieldOverrides });
  const mappings = useMemo(() => JSON.parse(mappingsKey), [mappingsKey]);
  const { fields, primary, mappedFields } = useMemo(() => sourceEvidence(columns, rows, mappings), [columns, rows, mappings]);
  const hasPhones = fields.some(field => field.id === "phone" && field.count > 0);
  const outcomeColumn = mappedFields.find(field => field.id === "outcome")?.column || "";
  const found = useMemo(() => Object.fromEntries(mappedFields.filter(field => field.column).map(field => [field.id, field.column])), [mappedFields]);
  const finished = Boolean(checked);
  useEffect(() => {
    // Centre the current step inside the step bar, and move nothing else on the page.
    const bar = stepNavigation.current,
      current = bar?.querySelector("[aria-current]");
    if (!bar || !current) return;
    bar.scrollTo({
      left: current.offsetLeft - (bar.clientWidth - current.clientWidth) / 2,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [step, hasPhones]);
  const stage = useRef(null);
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) return void (firstStep.current = false);
    const page = stage.current?.closest(".main-content");
    const card = stage.current;
    if (!page || !card) return;
    const top = card.getBoundingClientRect().top - page.getBoundingClientRect().top + page.scrollTop - 16;
    if (top < page.scrollTop || card.getBoundingClientRect().top > page.getBoundingClientRect().top + page.clientHeight / 2)
      page.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  }, [step]);
  // The meaning the engine gives each imported call status, read when the outcome step opens.
  useEffect(() => {
    if (!engine || step !== 1 || !hasPhones || !outcomeColumn || statuses?.column === outcomeColumn) return;
    let live = true;
    prepare({ name: dataset.name, columns, rows, outcomeColumn }).then(
      found => live && setStatuses({ column: outcomeColumn, items: found.statuses }),
      reason => live && setError(reason.message),
    );
    return () => {
      live = false;
    };
  }, [engine, step, hasPhones, outcomeColumn]); // eslint-disable-line react-hooks/exhaustive-deps
  const stages = ["Source fields", "Call outcomes", "Warning signs", "Results", "Save a copy"];
  const demoStages = [
    "Reading source rows",
    `Reviewing ${primary?.label.toLowerCase() || "source"} evidence`,
    "Comparing candidate pairs",
    "Building lead groups",
    "Preparing the review",
  ];
  const demoVerdict = lead => (!hasPhones && !["Do not call", "Possible duplicate"].includes(lead.verdict) ? "Unverified" : lead.verdict);
  const verdictOf = (lead, index) => (checked?.engine ? checked.results[index]?.verdict || "Unverified" : demoVerdict(lead));
  function reset() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    running.current?.abort();
    setChecked(null);
    setProgress(null);
    setCancelled(false);
    setError("");
  }
  function changeSource(id) {
    reset();
    setDatasetId(id);
    setFieldOverrides({});
    setStatuses(null);
    setStep(0);
  }
  async function cancel() {
    const job = running.current;
    reset();
    setCancelled(true);
    if (job?.jobId) await cancelJob(job.jobId).catch(() => undefined);
    notify("Check cancelled. Source data unchanged.");
  }
  function runDemo() {
    setProgress({ label: demoStages[0], value: 0, max: demoStages.length });
    for (let index = 1; index <= demoStages.length; index++)
      timers.current.push(
        setTimeout(() => {
          if (index === demoStages.length) {
            setProgress(null);
            setChecked({ engine: false });
          } else setProgress({ label: demoStages[index], value: index, max: demoStages.length });
        }, index * 500),
      );
  }
  async function run() {
    if (!primary || (!state.online && mode === "Cloud")) return;
    reset();
    setStep(3);
    if (!engine) return runDemo();
    const controller = new AbortController();
    running.current = controller;
    setProgress({ label: "Preparing the list", value: 0, max: 1 });
    const follow = {
      signal: controller.signal,
      onStart: jobId => (controller.jobId = jobId),
      onStage: event =>
        !controller.signal.aborted && setProgress({ label: STAGE_LABELS[event.stage] || "Checking", value: event.completed ?? 0, max: event.total || 1 }),
    };
    try {
      // Signed in to Turf's server: the check spends a credit per row, and is refused when the month's are used up.
      if (state.remote) {
        setProgress({ label: "Checking your credits", value: 0, max: 1 });
        await api.useCredits("skip_trace", rows.length, crypto.randomUUID(), dataset.name).catch(reason => {
          if (reason.code === "offline") throw new Error("Skip Tracing needs a connection to Turf's server to count your credits. Try again when you are online.");
          throw reason;
        });
        if (controller.signal.aborted) return;
        setProgress({ label: "Preparing the list", value: 0, max: 1 });
      }
      const prepared = await prepare({ name: dataset.name, columns, rows });
      if (!hasPhones) {
        // No phone numbers to check: the engine still finds the leads this list repeats, from names and addresses.
        const config = engineConfig(prepared.suggestion.config, columns, rows, found, { region });
        const result = signals.duplicates
          ? await checkRepeats({ datasetId: prepared.datasetId, config, ...follow })
          : { report: null, results: rows.map(() => ({ verdict: "No phone", why: "No phone number in this list", bestPhone: "" })) };
        if (controller.signal.aborted) return;
        setChecked({ engine: true, datasetId: prepared.datasetId, noPhones: true, ...result });
        return;
      }
      let meanings = [];
      if (signals.outcomes && outcomeColumn)
        meanings = statuses?.column === outcomeColumn ? statuses.items : (await prepare({ name: dataset.name, columns, rows, outcomeColumn })).statuses;
      const outcomes = meanings.length ? { column: outcomeColumn, map: Object.fromEntries(meanings.map(item => [item.key, item.outcomes || []])) } : null;
      const config = engineConfig(prepared.suggestion.config, columns, rows, found, { region, findDuplicates: signals.duplicates, outcomes });
      const result = await check({ datasetId: prepared.datasetId, config, ...follow });
      if (controller.signal.aborted) return;
      setChecked({ engine: true, datasetId: prepared.datasetId, ...result });
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason.message);
    } finally {
      if (running.current === controller) running.current = null;
      setProgress(null);
    }
  }
  async function save() {
    const verdicts = Object.fromEntries(rows.map((lead, index) => [lead.id, verdictOf(lead, index)]));
    if (checked.engine && checked.report)
      try {
        await saveCopy({ datasetId: checked.datasetId, config: checked.config, jobId: checked.jobId, name: dataset.name + " · checked" });
      } catch (reason) {
        notify("The checked copy could not be saved: " + reason.message);
        return;
      }
    dispatch({ type: "CHECK", id: datasetId, verdicts: checked.engine ? verdicts : null });
    notify(checked.engine ? "Check saved. Lead verdicts updated." : "Demo check saved");
    navigate("lists/" + datasetId);
  }
  // A list with no phones is reviewed best owner first; a phone check in the list's own order.
  const reviewOrder = useMemo(() => {
    const order = rows.map((lead, index) => ({ lead, index }));
    return checked?.noPhones ? order.sort((a, b) => (checked.results[b.index]?.score ?? 0) - (checked.results[a.index]?.score ?? 0)) : order;
  }, [rows, checked]);
  const [reviewRows, reviewMore] = useShowMore(reviewOrder);
  const counts = checked?.engine ? rows.reduce((all, lead, index) => ({ ...all, [verdictOf(lead, index)]: (all[verdictOf(lead, index)] || 0) + 1 }), {}) : null;
  const allowed = capability(state, "review") || capability(state, "import");
  if (!allowed) return <Empty title="Skip Tracing is outside this role">Data operators work here before leads enter the outreach queue.</Empty>;
  return (
    <div className="skip-workspace">
      <PageHeader title="Skip Tracing" description="Map a list, check its contact details, and review the results.">
        <Segmented
          label="Skip Tracing execution mode"
          value={mode}
          options={["Local", "Cloud"]}
          onChange={value => {
            if (value === "Cloud" && !state.online) notify("Cloud checks need a connection. Local mode remains available.");
            else setMode(value);
          }}
        />
      </PageHeader>
      <div className="execution-card">
        <span className="execution-icon">{mode === "Local" ? <HardDrives size={23} /> : <Cloud size={23} />}</span>
        <div>
          <strong>{mode === "Local" ? "Local workspace · works offline" : "Cloud workspace · shared job"} </strong>
          <p>
            {mode === "Local" ? "Your source stays on this device until you choose to publish it." : "Your team can follow the job and review its results."}
          </p>
        </div>
        <Badge tone={engine ? "good" : ""}>{engine === null ? "Connecting…" : engine ? "Turf engine" : "Demo check"}</Badge>
      </div>
      <nav ref={stepNavigation} className="wizard-steps" aria-label="Skip Tracing steps">
        {stages.map(
          (label, index) =>
            (index !== 1 || hasPhones) && (
              <button
                key={label}
                aria-current={step === index ? "step" : undefined}
                className={step === index ? "active" : ""}
                disabled={(index >= 4 && !finished) || (index > 0 && !primary) || Boolean(progress)}
                onClick={() => setStep(index)}
              >
                <span>{!hasPhones && index > 1 ? index : index + 1}</span>
                {label}
              </button>
            ),
        )}
      </nav>
      <PropertyMap rows={rows} mappings={mappings} title="Source location map" />
      <div ref={stage} className="skip-layout">
        <Card
          className="skip-stage"
          title={stages[step]}
          subtitle={step < 3 ? "Use the source's actual fields. Keep every original value." : "Review before saving."}
        >
          {step === 0 && (
            <>
              <Field label="Source list">
                <Select aria-label="Skip Tracing source list" value={datasetId} onChange={event => changeSource(event.target.value)}>
                  {datasets.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="skip-evidence-banner" role="status">
                <ShieldCheck size={26} weight="light" />
                <div>
                  <strong>{primary ? `Starting with ${primary.label.toLowerCase()} evidence` : "Choose an identity field to continue"}</strong>
                  <p>
                    {hasPhones
                      ? "Phone fields found. Address, email and owner context stay alongside them."
                      : primary
                        ? `No populated phone field found. We’ll use ${primary.label.toLowerCase()} instead and skip phone-only checks.`
                        : "No usable identity, address or coordinate pair was detected. Map an available source column below."}
                  </p>
                </div>
              </div>
              <SourceFieldMapping
                columns={columns}
                rows={rows}
                mappings={mappings}
                hideEmpty={hideEmpty}
                onChange={value => {
                  setFieldOverrides(value);
                  setStatuses(null);
                  reset();
                }}
              />
              <Button
                disabled={!dataset}
                onClick={() => {
                  dispatch({ type: "SOURCE_MAPPING", id: datasetId, mappings });
                  notify("Source mapping saved for this list");
                }}
              >
                Save source mapping
              </Button>
              {hasPhones && (
                <Field label="Default phone region">
                  <Select value={region} onChange={event => (setRegion(event.target.value), reset())}>
                    <option value="US">United States (+1)</option>
                    <option value="CA">Canada (+1)</option>
                    <option value="GB">United Kingdom (+44)</option>
                  </Select>
                </Field>
              )}
              <div className="skip-source-preview">
                <h3>Source preview</h3>
                <Checkbox label="Hide empty fields" checked={hideEmpty} onChange={event => setHideEmpty(event.target.checked)} />
                <p className="muted">First {Math.min(4, rows.length)} rows · original values · scroll to see every field</p>
                <div className="skip-preview-scroll" tabIndex={0} role="region" aria-label="Source preview columns">
                  <table>
                    <thead>
                      <tr>
                        {shownColumns.map(column => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 4).map(row => (
                        <tr key={row.id}>
                          {shownColumns.map(column => (
                            <td key={column}>{sourceValue(row, column) || <span className="muted">—</span>}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="skip-step-actions">
                <p className="muted">Only available evidence is used. Missing fields never block a useful starting point.</p>
                <Button variant="primary" disabled={!primary} onClick={() => setStep(hasPhones ? 1 : 2)}>
                  {hasPhones ? "Continue to call outcomes" : "Continue to warning signs"} <ArrowRight size={16} />
                </Button>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="Imported call-status field">
                <Select
                  value={outcomeColumn}
                  onChange={event => {
                    setFieldOverrides({ ...fieldOverrides, outcome: event.target.value });
                    setStatuses(null);
                    reset();
                  }}
                >
                  <option value="">Not mapped</option>
                  {columns.map(column => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </Select>
              </Field>
              {engine && outcomeColumn ? (
                statuses?.column === outcomeColumn ? (
                  statuses.items.length ? (
                    <div className="mapping-preview" aria-label="What each imported status means">
                      {statuses.items.map(item => (
                        <div key={item.key}>
                          <span>{item.value ?? item.key}</span>
                          {item.outcomes?.length ? (
                            item.outcomes.map(kind => <Status key={kind} value={OUTCOME_NAMES[kind] || kind} />)
                          ) : (
                            <Badge>Keep for follow-up</Badge>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">The call-status field is empty in this list.</p>
                  )
                ) : (
                  <p className="muted" role="status">
                    Reading the statuses in {outcomeColumn}…
                  </p>
                )
              ) : (
                <div className="mapping-preview">
                  <div>
                    <span>Reached a person</span>
                    <Status value="Contacted" />
                  </div>
                  <div>
                    <span>No answer / voicemail</span>
                    <Badge>Keep for follow-up</Badge>
                  </div>
                  <div>
                    <span>Wrong number</span>
                    <Status value="Wrong number" />
                  </div>
                  <div>
                    <span>Do not call</span>
                    <Status value="Do not call" />
                  </div>
                </div>
              )}
              <p className="muted">Outcomes from every source stay distinct from phone quality.</p>
              <Button variant="primary" onClick={() => setStep(2)}>
                Continue <ArrowRight size={16} />
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <div className="signal-list">
                {[
                  ["duplicates", "Find repeated leads", "One owner with several properties remains several leads."],
                  ["outcomes", "Use known call outcomes", "Keep wrong-number and owner context attached."],
                  ["dnc", "Review do-not-call evidence", "Blocked numbers remain blocked."],
                  ["age", "Surface old or conflicting evidence", "Show what needs a fresh review."],
                ].map(([key, title, description]) => {
                  const skipped = !hasPhones && ["outcomes", "dnc"].includes(key);
                  const fixed = engine && ["dnc", "age"].includes(key);
                  return (
                    <label key={key}>
                      <input
                        type="checkbox"
                        disabled={skipped || fixed}
                        checked={skipped ? false : fixed ? true : signals[key]}
                        onChange={event => setSignals({ ...signals, [key]: event.target.checked })}
                      />
                      <div>
                        <strong>{title}</strong>
                        <p>
                          {skipped
                            ? "Skipped · no populated phone field. Existing blocked records stay blocked."
                            : fixed
                              ? description + " Always on in the Turf engine."
                              : description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
              <Button variant="primary" icon={ShieldCheck} disabled={!primary || engine === null || (!state.online && mode === "Cloud")} onClick={run}>
                {engine ? "Run check" : "Run demo check"}
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              {progress ? (
                <div className="job-progress">
                  <ShieldCheck size={40} weight="light" />
                  <h3>{progress.label}</h3>
                  <progress value={progress.value} max={progress.max} />
                  <p>
                    {engine ? "Turf engine" : "Simulated " + mode.toLowerCase() + " check"} · {rows.length} rows
                  </p>
                  <Button onClick={cancel}>Cancel check</Button>
                </div>
              ) : error ? (
                <Empty title="The check could not finish" action={<Button onClick={run}>Try again</Button>}>
                  {error} Original source rows are unchanged.
                </Empty>
              ) : finished ? (
                <>
                  <div className="review-metrics">
                    <div>
                      <strong>{rows.length.toLocaleString()}</strong>
                      <small>source rows</small>
                    </div>
                    {checked.noPhones ? (
                      <div>
                        <strong>{(counts["No phone"] || 0).toLocaleString()}</strong>
                        <small>leads to find phone numbers for</small>
                      </div>
                    ) : (
                      <div>
                        <strong>{checked.engine ? counts["Ready to call"] || 0 : rows.filter(item => demoVerdict(item) === "Ready to call").length}</strong>
                        <small>{checked.engine ? "ready to call" : "ready in sample evidence"}</small>
                      </div>
                    )}
                    <div>
                      <strong>
                        {checked.engine
                          ? counts["Possible duplicate"] || 0
                          : signals.duplicates
                            ? rows.filter(item => item.verdict === "Possible duplicate").length
                            : 0}
                      </strong>
                      <small>possible repeats</small>
                    </div>
                    {checked.noPhones && checked.engine && (
                      <>
                        <div>
                          <strong>{(checked.owners || 0).toLocaleString()}</strong>
                          <small>owners</small>
                        </div>
                        <div>
                          <strong>{(checked.sameOwner || 0).toLocaleString()}</strong>
                          <small>owner has other properties here</small>
                        </div>
                        <div>
                          <strong>{(checked.absentee || 0).toLocaleString()}</strong>
                          <small>absentee owners</small>
                        </div>
                        <div>
                          <strong>{(checked.outOfState || 0).toLocaleString()}</strong>
                          <small>mail out of state</small>
                        </div>
                        <div>
                          <strong>{(checked.vacant || 0).toLocaleString()}</strong>
                          <small>vacant</small>
                        </div>
                        {checked.government > 0 && (
                          <div>
                            <strong>{checked.government.toLocaleString()}</strong>
                            <small>government owned · not leads</small>
                          </div>
                        )}
                      </>
                    )}
                    {checked.engine && !checked.noPhones && (
                      <div>
                        <strong>{(counts["Wrong number"] || 0) + (counts["Do not call"] || 0)}</strong>
                        <small>blocked or wrong</small>
                      </div>
                    )}
                  </div>
                  {checked.noPhones && (
                    <p className="notice subtle">
                      This list has no phone numbers, so there is nothing to call yet. Turf found each property&apos;s owner (the same name at the same mailing
                      address, in any ZIP code), the properties each owner holds here, and scored them: vacant +3, absentee +2, owns several +2, mails out of
                      state +1, investor +1, owned 25+ years +1. A repeat is the same property listed twice; one owner with several properties is not a
                      repeat. Add phone numbers (a skip-tracing data source) and run the check again to see which are ready to call.
                    </p>
                  )}
                  <div className="review-rows">
                    {reviewRows.map(({ lead, index }) => (
                      <div key={lead.id}>
                        <LeadLink lead={lead} />
                        <Status value={verdictOf(lead, index)} />
                        {checked.engine && (
                          <small className="muted review-why">
                            {checked.noPhones && checked.results[index]?.reasons?.length
                              ? `Score ${checked.results[index].score}: ${checked.results[index].reasons.join(", ")}`
                              : checked.results[index]?.why || checked.results[index]?.duplicate}
                          </small>
                        )}
                        <Button onClick={() => navigate("work/leads/" + lead.id)}>Review</Button>
                      </div>
                    ))}
                    {reviewMore}
                  </div>
                  {!checked.engine && (
                    <p className="notice subtle">
                      These are illustrative results from the sample records. The Turf engine runs in the desktop app and on the dev server.
                    </p>
                  )}
                  <Button variant="primary" onClick={() => setStep(4)}>
                    Continue to save <ArrowRight size={16} />
                  </Button>
                </>
              ) : (
                <Empty
                  title={cancelled ? "Check cancelled" : "Your results will appear here"}
                  action={
                    <Button onClick={run} disabled={!primary || engine === null}>
                      {engine ? "Run check" : "Run demo check"}
                    </Button>
                  }
                >
                  Original source rows are unchanged.
                </Empty>
              )}
            </>
          )}
          {step === 4 && finished && (
            <>
              <CheckCircle size={38} weight="light" />
              <h3>Keep a reviewable copy.</h3>
              <p className="body-copy">
                {checked.noPhones
                  ? "Save the check: each lead is marked as a possible repeat or as needing phone numbers. Original imported values stay unchanged. Or export a reviewed CSV."
                  : checked.engine
                    ? "Save the check: each lead gets its verdict and the engine keeps a checked copy beside the original. Or export a reviewed CSV."
                    : "Save the demo check to this workspace, or export a reviewed CSV. Original imported values stay unchanged."}
              </p>
              <div className="row">
                <Button variant="primary" onClick={save}>
                  {checked.engine ? "Save check" : "Save demo check"}
                </Button>
                <Button
                  icon={DownloadSimple}
                  onClick={() =>
                    downloadCsv(
                      exportName(dataset?.name, checked.engine ? "checked" : "demo check"),
                      checked.engine
                        ? [
                            [...columns, "Verdict", "Best phone", "Why", "Duplicate status", "Same owner rows", ...(checked.noPhones ? OWNER_COLUMNS : [])],
                            ...rows.map((lead, index) => [
                              ...columns.map(column => sourceValue(lead, column)),
                              verdictOf(lead, index),
                              checked.results[index]?.bestPhone || "",
                              checked.results[index]?.why || "",
                              checked.results[index]?.duplicate || "",
                              checked.results[index]?.sameOwner || "",
                              ...(checked.noPhones ? ownerCells(checked.results[index]) : []),
                            ]),
                          ]
                        : [
                            [...columns, "Sample verdict", "Starting evidence"],
                            ...rows.map(lead => [...columns.map(column => sourceValue(lead, column)), demoVerdict(lead), primary?.label || "None"]),
                          ],
                    )
                  }
                >
                  {checked.engine ? "Export CSV" : "Export demo CSV"}
                </Button>
                {checked.engine && checked.noPhones && (
                  <Button
                    icon={DownloadSimple}
                    onClick={() => downloadCsv(exportName(dataset?.name, "by owner"), [[...columns, ...OWNER_COLUMNS], ...ownerRows(columns, rows, checked.results)])}
                  >
                    Export one row per owner
                  </Button>
                )}
              </div>
            </>
          )}
        </Card>
        <aside>
          <Card title="Check context">
            <div className="definition-list">
              <div>
                <small>Source</small>
                <strong>{dataset?.name || "No source selected"}</strong>
              </div>
              <div>
                <small>Rows in your view</small>
                <strong>{rows.length}</strong>
              </div>
              <div>
                <small>Starting evidence</small>
                <strong>{primary ? `${primary.label} · ${primary.column}` : "Needs a field mapping"}</strong>
              </div>
              <div>
                <small>Execution</small>
                <strong>
                  {mode === "Local" ? "This device" : "Shared cloud job"}
                  {engine ? " · Turf engine" : ""}
                </strong>
              </div>
              <div>
                <small>Source safety</small>
                <strong>Original data preserved</strong>
              </div>
            </div>
          </Card>
          <Card title="Evidence order" subtitle="We move to the next available field.">
            <ol className="skip-evidence-order">
              {fields.map(field => (
                <li key={field.id} className={primary?.id === field.id ? "is-primary" : ""}>
                  <span>
                    <strong>{field.label}</strong>
                    <small>{field.column ? `${field.column} · ${field.count} rows` : "Not detected"}</small>
                  </span>
                  <Badge tone={primary?.id === field.id ? "good" : ""}>{primary?.id === field.id ? "Start here" : field.count ? "Available" : "Skip"}</Badge>
                </li>
              ))}
            </ol>
          </Card>
          <Card title="People and properties stay distinct">
            <p className="body-copy">
              A shared phone alone does not prove two people are the same. Different units and different properties need their own context.
            </p>
            <Badge tone="peach">Review comes before publishing</Badge>
          </Card>
        </aside>
      </div>
    </div>
  );
}
