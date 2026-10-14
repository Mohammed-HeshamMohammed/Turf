import { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import { ArrowRight, ArrowUpRight, CheckCircle, Cloud, DownloadSimple, FileCsv, HardDrives, ShieldCheck, UploadSimple } from "@phosphor-icons/react";
import { ROLES } from "./data.js";
import { capability, uid, visibleLeads } from "./model.js";
import { useCrm } from "./context.jsx";
import { Badge, Button, Card, Empty, Field, LeadLink, PageHeader, Search, Segmented, Status, downloadCsv, Breadcrumb } from "./ui.jsx";

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
    const pick = (row, options) => {
      const entry = Object.entries(row).find(([key]) => options.includes(key.trim().toLowerCase().replaceAll("_", " ")));
      return String(entry?.[1] || "").trim();
    };
    const imported = rows
      .slice(0, 200)
      .map((row, index) => ({
        id: uid(),
        datasetId,
        name: pick(row, ["owner", "owner name", "name", "full name"]) || "Imported owner " + (index + 1),
        address: pick(row, ["address", "property address", "street"]) || "Address not supplied",
        city: pick(row, ["city"]) || "Tampa",
        region: pick(row, ["state", "region"]) || "FL",
        zip: pick(row, ["zip", "zip code"]) || "",
        phone: pick(row, ["phone", "phone number", "mobile"]),
        email: pick(row, ["email"]),
        stage: "New",
        assignee: "Unassigned",
        team: ROLES[state.role].team || "Tampa",
        callback: "",
        source: "CSV import",
        verdict: "Unverified",
        shared: false,
        version: 1,
        priority: "Normal",
        value: Number(pick(row, ["value", "price"])) || 0,
        beds: 3,
        baths: 2,
        area: 1600,
        notes: [],
        motivation: "Imported from " + name + ". Review source fields before outreach.",
      }));
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
                  ["Owner", "Address", "Phone", "Stage"],
                  ...leads.filter(lead => lead.datasetId === id).map(lead => [lead.name, lead.address, lead.phone, lead.stage]),
                ])
              }
            >
              Export view
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
                  <th />
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
      <PageHeader eyebrow="Source data" title="Good work starts with a good list." description="Original rows, contact evidence, and CRM work stay connected.">
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
  const [phoneColumn, setPhoneColumn] = useState("Phone");
  const [signals, setSignals] = useState({ duplicates: true, outcomes: true, dnc: true, age: true });
  const [progress, setProgress] = useState(-1);
  const [finished, setFinished] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const dataset = datasets.find(item => item.id === datasetId);
  const rows = leads.filter(lead => lead.datasetId === datasetId);
  const stages = ["Phone columns", "Call outcomes", "Warning signs", "Results", "Save a copy"];
  const jobStages = ["Reading source rows", "Normalizing phone evidence", "Comparing candidate pairs", "Building lead groups", "Preparing the review"];
  function cancel() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setProgress(-1);
    setCancelled(true);
    notify("Demo check cancelled. Source data unchanged.");
  }
  function run() {
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
    <>
      <PageHeader
        eyebrow="Contact evidence"
        title="A clearer picture, before the first call."
        description="Check source data, keep your evidence, and review possible repeats."
      >
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
      <div className="wizard-steps">
        {stages.map((label, index) => (
          <button key={label} className={step === index ? "active" : ""} disabled={index >= 4 && !finished} onClick={() => setStep(index)}>
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </div>
      <div className="skip-layout">
        <Card title={stages[step]} subtitle={step < 3 ? "Use the source's actual fields. Keep every original value." : "Review before saving."}>
          {step === 0 && (
            <>
              <Field label="Source list">
                <select
                  aria-label="Skip Tracing source list"
                  value={datasetId}
                  onChange={event => {
                    setDatasetId(event.target.value);
                    setFinished(false);
                  }}
                >
                  {datasets.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Phone column">
                <select value={phoneColumn} onChange={event => setPhoneColumn(event.target.value)}>
                  {[...new Set(["Phone", ...(dataset?.columns || [])])].map(column => (
                    <option key={column}>{column}</option>
                  ))}
                </select>
              </Field>
              <Field label="Default region">
                <select defaultValue="US">
                  <option value="US">United States (+1)</option>
                  <option value="CA">Canada (+1)</option>
                  <option value="GB">United Kingdom (+44)</option>
                </select>
              </Field>
              <p className="body-copy">The phone is evidence, not the identity of the property owner. Shared household or office numbers need context.</p>
              <Button variant="primary" onClick={() => setStep(1)}>
                Continue <ArrowRight size={16} />
              </Button>
            </>
          )}
          {step === 1 && (
            <>
              <Field label="Imported call-status field">
                <select defaultValue="None">
                  <option>None</option>
                  <option>Call outcome</option>
                  <option>Status</option>
                </select>
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
                    <input type="checkbox" checked={signals[key]} onChange={event => setSignals({ ...signals, [key]: event.target.checked })} />
                    <div>
                      <strong>{title}</strong>
                      <p>{description}</p>
                    </div>
                  </label>
                ))}
              </div>
              <Button variant="primary" icon={ShieldCheck} disabled={!dataset || (!state.online && mode === "Cloud")} onClick={run}>
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
                      <strong>{rows.filter(item => item.verdict === "Ready to call").length}</strong>
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
                        <Status value={lead.verdict} />
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
                    <Button onClick={run} disabled={!dataset}>
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
                      ["Owner", "Address", "Phone", "Sample verdict"],
                      ...rows.map(lead => [lead.name, lead.address, lead.phone, lead.verdict]),
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
                <small>Phone field</small>
                <strong>{phoneColumn}</strong>
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
          <Card title="People and properties stay distinct">
            <p className="body-copy">
              A shared phone alone does not prove two people are the same. Different units and different properties need their own context.
            </p>
            <Badge tone="peach">Review comes before publishing</Badge>
          </Card>
        </aside>
      </div>
    </>
  );
}
