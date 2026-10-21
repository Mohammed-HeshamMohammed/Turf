import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import { ArrowRight, ArrowUpRight, CheckCircle, Phone, Cloud, DownloadSimple, FileCsv, HardDrives, ShieldCheck, UploadSimple } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { capability, uid, visibleLeads } from "./model.js";
import { useCrm } from "./context.jsx";
import { mappedRecord, sourceEvidence, sourceValue } from "./skiptrace-fields.js";
import { SourceFieldMapping } from "./SourceFieldMapping.jsx";
import { PropertyMap } from "./PropertyMap.jsx";
import { Badge, Select, Button, Card, Checkbox, Empty, Field, LeadLink, PageHeader, Search, Segmented, Status, downloadCsv, Breadcrumb } from "./ui.jsx";

export function Lists({ id }) {
  const { state, dispatch, navigate, notify } = useCrm();
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const input = useRef(null);
  const leads = visibleLeads(state);
  const datasetIds = new Set(leads.map(item => item.datasetId));
  const datasets = state.datasets.filter(item => datasetIds.has(item.id) || (capability(state, "import") && item.team === (ROLES[state.role].team || "Tampa")));
  const dataset = datasets.find(item => item.id === id);
  function importRows(rows, name, columns) {
    if (!rows.length) {
      setError("The CSV has no data rows. Choose a file with a header and at least one record.");
      return;
    }
    const datasetId = uid();
    const imported = rows.slice(0, 200).map((row, index) => {
      const data = mappedRecord(columns, { sourceValues: row });
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
        value: Number(data.value.replace(/[$,]/g, "")) || 0,
        beds: 3,
        baths: 2,
        area: 1600,
        notes: [],
        motivation: "Imported from " + name + ". Review source fields before outreach.",
      };
    });
    dispatch({
      type: "IMPORT",
      dataset: {
        id: datasetId,
        name,
        description: "Local prototype import",
        status: "Not checked",
        team: ROLES[state.role].team || "Tampa",
        date: "Oct 15",
        columns,
      },
      leads: imported,
    });
    setError("");
    notify("Imported " + imported.length + " preview rows" + (rows.length > 200 ? " · preview limited to 200" : ""));
    navigate("lists/" + datasetId);
  }
  async function readFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("This UI preview imports CSV files. Other formats belong to the planned import service.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Choose a CSV smaller than 2 MB for this local UI preview.");
      return;
    }
    try {
      const result = Papa.parse(await file.text(), { header: true, skipEmptyLines: "greedy" });
      if (result.errors.length) {
        setError("CSV could not be read: " + result.errors[0].message);
        return;
      }
      importRows(result.data, file.name.replace(/\.csv$/i, ""), result.meta.fields || []);
    } catch {
      setError("The file could not be read. Try another CSV.");
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
                downloadCsv("turf-list-preview.csv", [
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
        <PropertyMap rows={leads.filter(lead => lead.datasetId === id)} title="Source list map" />
        <Card className="table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Owner</th>
                  <th>Property</th>
                  <th>Best phone</th>
                  <th>Quality</th>
                  <th>CRM stage</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {leads
                  .filter(lead => lead.datasetId === id)
                  .map(lead => (
                    <tr key={lead.id}>
                      <td>
                        <LeadLink lead={lead} detail={false} />
                      </td>
                      <td>
                        {lead.address}
                        <small>
                          {lead.city}, {lead.region}
                        </small>
                      </td>
                      <td>{lead.phone || <span className="muted">No phone supplied</span>}</td>
                      <td>
                        <Status value={lead.verdict} />
                      </td>
                      <td>
                        <Status value={lead.stage} />
                      </td>
                      <td>
                        <Button onClick={() => navigate("work/leads/" + lead.id)}>
                          Open lead <ArrowUpRight size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
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
          <p>Drop a CSV here, or choose a file. This prototype keeps imported data in this browser only.</p>
          <div className="row">
            <Button onClick={() => input.current.click()}>Choose CSV</Button>
            <Button onClick={sample}>Try a sample import</Button>
          </div>
          <small>Preview limit: 2 MB / 200 rows</small>
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
  const [progress, setProgress] = useState(-1);
  const [finished, setFinished] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const timers = useRef([]);
  const stepNavigation = useRef(null);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const dataset = datasets.find(item => item.id === datasetId);
  const rows = leads.filter(lead => lead.datasetId === datasetId);
  const columns = dataset?.columns || [];
  const shownColumns = hideEmpty ? columns.filter(column => rows.some(row => String(sourceValue(row, column) ?? "").trim())) : columns;
  const mappings = { ...dataset?.fieldMappings, ...fieldOverrides };
  const { fields, primary } = sourceEvidence(columns, rows, mappings);
  const hasPhones = fields.some(field => field.id === "phone" && field.count > 0);
  useEffect(() => {
    stepNavigation.current?.querySelector("[aria-current]")?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
  }, [step, hasPhones]);
  const stages = ["Source fields", "Call outcomes", "Warning signs", "Results", "Save a copy"];
  const jobStages = [
    "Reading source rows",
    `Reviewing ${primary?.label.toLowerCase() || "source"} evidence`,
    "Comparing candidate pairs",
    "Building lead groups",
    "Preparing the review",
  ];
  const verdict = lead => (!hasPhones && !["Do not call", "Possible duplicate"].includes(lead.verdict) ? "Unverified" : lead.verdict);
  function changeSource(id) {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setDatasetId(id);
    setFieldOverrides({});
    setFinished(false);
    setProgress(-1);
    setCancelled(false);
    setStep(0);
  }
  function cancel() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setProgress(-1);
    setCancelled(true);
    notify("Demo check cancelled. Source data unchanged.");
  }
  function run() {
    if (!primary || (!state.online && mode === "Cloud")) return;
    timers.current.forEach(clearTimeout);
    setProgress(0);
    setFinished(false);
    setCancelled(false);
    setStep(3);
    for (let index = 1; index <= jobStages.length; index++)
      timers.current.push(
        setTimeout(() => {
          if (index === jobStages.length) {
            setProgress(-1);
            setFinished(true);
          } else setProgress(index);
        }, index * 500),
      );
  }
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
        <Badge tone="good">UI simulation</Badge>
      </div>
      <nav ref={stepNavigation} className="wizard-steps" aria-label="Skip Tracing steps">
        {stages.map(
          (label, index) =>
            (index !== 1 || hasPhones) && (
              <button
                key={label}
                aria-current={step === index ? "step" : undefined}
                className={step === index ? "active" : ""}
                disabled={(index >= 4 && !finished) || (index > 0 && !primary) || progress >= 0}
                onClick={() => setStep(index)}
              >
                <span>{!hasPhones && index > 1 ? index : index + 1}</span>
                {label}
              </button>
            ),
        )}
      </nav>
      <PropertyMap rows={rows} mappings={mappings} title="Source location map" />
      <div className="skip-layout">
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
                  setFinished(false);
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
                  <Select defaultValue="US">
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
                  value={mappings.outcome ?? sourceEvidence(columns, rows).mappedFields.find(field => field.id === "outcome").column}
                  onChange={event => setFieldOverrides({ ...fieldOverrides, outcome: event.target.value })}
                >
                  <option value="">Not mapped</option>
                  {columns.map(column => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </Select>
              </Field>
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
                ].map(([key, title, description]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      disabled={!hasPhones && ["outcomes", "dnc"].includes(key)}
                      checked={!hasPhones && ["outcomes", "dnc"].includes(key) ? false : signals[key]}
                      onChange={event => setSignals({ ...signals, [key]: event.target.checked })}
                    />
                    <div>
                      <strong>{title}</strong>
                      <p>
                        {!hasPhones && ["outcomes", "dnc"].includes(key)
                          ? "Skipped · no populated phone field. Existing blocked records stay blocked."
                          : description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
              <Button variant="primary" icon={ShieldCheck} disabled={!primary || (!state.online && mode === "Cloud")} onClick={run}>
                Run demo check
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              {progress >= 0 ? (
                <div className="job-progress">
                  <ShieldCheck size={40} weight="light" />
                  <h3>{jobStages[progress]}</h3>
                  <progress value={progress + 1} max={jobStages.length} />
                  <p>
                    Simulated {mode.toLowerCase()} check · {rows.length} sample rows
                  </p>
                  <Button onClick={cancel}>Cancel check</Button>
                </div>
              ) : finished ? (
                <>
                  <div className="review-metrics">
                    <div>
                      <strong>{rows.length}</strong>
                      <small>source rows</small>
                    </div>
                    <div>
                      <strong>{rows.filter(item => verdict(item) === "Ready to call").length}</strong>
                      <small>ready in sample evidence</small>
                    </div>
                    <div>
                      <strong>{signals.duplicates ? rows.filter(item => item.verdict === "Possible duplicate").length : 0}</strong>
                      <small>possible repeats</small>
                    </div>
                  </div>
                  <div className="review-rows">
                    {rows.map(lead => (
                      <div key={lead.id}>
                        <LeadLink lead={lead} />
                        <Status value={verdict(lead)} />
                        <Button onClick={() => navigate("work/leads/" + lead.id)}>Review</Button>
                      </div>
                    ))}
                  </div>
                  <p className="notice subtle">
                    These are illustrative results from the sample records. This UI does not run the planned native matching engine.
                  </p>
                  <Button variant="primary" onClick={() => setStep(4)}>
                    Continue to save <ArrowRight size={16} />
                  </Button>
                </>
              ) : (
                <Empty
                  title={cancelled ? "Check cancelled" : "Your results will appear here"}
                  action={
                    <Button onClick={run} disabled={!primary}>
                      Run demo check
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
              <p className="body-copy">Save the demo check to this workspace, or export a reviewed CSV. Original imported values stay unchanged.</p>
              <div className="row">
                <Button
                  variant="primary"
                  onClick={() => {
                    dispatch({ type: "CHECK", id: datasetId });
                    notify("Demo check saved");
                    navigate("lists/" + datasetId);
                  }}
                >
                  Save demo check
                </Button>
                <Button
                  icon={DownloadSimple}
                  onClick={() =>
                    downloadCsv("turf-demo-check.csv", [
                      [...columns, "Sample verdict", "Starting evidence"],
                      ...rows.map(lead => [...columns.map(column => sourceValue(lead, column)), verdict(lead), primary?.label || "None"]),
                    ])
                  }
                >
                  Export demo CSV
                </Button>
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
                <strong>{mode === "Local" ? "This device" : "Shared cloud job"}</strong>
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
