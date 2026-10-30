// The Skip Tracing page's engine client against the real Caller Whale engine (service/ at the repository root, Python): the same commands the page
// sends, through a fetch that speaks to the service process the way the dev server's /rpc bridge does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { check, checkRepeats, crmVerdict, engineAvailable, engineConfig, locatable, prepare, saveCopy, sourceCsv, stateCode, zipPlaces } from "../src/engine.js";
import { ALLOWED_COMMANDS, refusal } from "../scripts/service-bridge.mjs";

// CALLERWHALE_SERVICE_ROOT: where the engine is when this part is checked out alone (skip-engine-production).
const root = process.env.CALLERWHALE_SERVICE_ROOT ? resolve(process.env.CALLERWHALE_SERVICE_ROOT) : resolve(import.meta.dirname, "../../../../../service");
let child;

before(() => {
  child = spawn(process.env.CALLERWHALE_PYTHON ?? "python", ["-m", "turf_service.server", "--resources", root], {
    cwd: root,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONPATH: root, CALLERWHALE_APP_DATA: mkdtempSync(join(tmpdir(), "turf-crm-engine-")) },
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let id = 0;
  let queue = Promise.resolve();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "/rpc");
    const { command, payload } = JSON.parse(init.body);
    assert.ok(ALLOWED_COMMANDS.has(command), "the page only sends commands the bridge allows: " + command);
    const turn = queue.then(async () => {
      child.stdin.write(JSON.stringify({ id: ++id, schema_version: 1, command, payload }) + "\n");
      return (await lines.next()).value;
    });
    queue = turn.catch(() => undefined);
    const line = await turn;
    return { ok: true, json: async () => JSON.parse(line) };
  };
});

after(() => child?.kill());

const columns = ["Owner", "Address", "Phone", "Mobile", "Zip", "Call Status"];
const value = (lead, column) => lead.sourceValues[column];
const lead = (id, values) => ({ id, sourceValues: Object.fromEntries(columns.map((column, index) => [column, values[index]])) });
const rows = [
  lead("a", ["Sarah Johnson", "1842 Palm Avenue", "(813) 274-6610", "", "33602", "Interested"]),
  lead("b", ["Michael Bennett", "620 Willow Street", "(813) 274-6621", "", "33603", "Wrong number"]),
  lead("c", ["Sarah Johnson", "1842 Palm Avenue", "(813) 274-6610", "", "33602", ""]),
  lead("d", ["Nora Diaz", "77 Bay Road", "(813) 555-0104", "", "33604", ""]),
  lead("e", ["Owen Price", "4 Oak Court", "", "", "33605", ""]),
  lead("f", ["Ruth Lane", "9 Cedar Way", "(813) 274-6688", "", "33606", "DNC - do not call"]),
];
const mappings = { phone: "Phone", name: "Owner", address: "Address", zip: "Zip", outcome: "Call Status" };

test("the source is sent exactly as it is, commas and quotes included", () => {
  const csv = Buffer.from(sourceCsv(["A", "B"], [{ sourceValues: { A: 'Say "hi", ok', B: "Café" } }]), "base64").toString("utf8");
  assert.equal(csv, 'A,B\r\n"Say ""hi"", ok",Café');
});

test("the setup takes the CRM mapping, populated phone columns only", () => {
  const config = engineConfig({ region: "US", phone_columns: [] }, columns, rows, mappings, { region: "CA", findDuplicates: false });
  assert.deepEqual(config.phone_columns, ["Phone"], "Mobile is empty in every row");
  assert.equal(config.region, "CA");
  assert.equal(config.find_duplicates, false);
  assert.equal(config.name_column, "Owner");
  assert.equal(config.outcome, null);
});

test("the dev bridge only serves this computer and the page's own origin", () => {
  const ok = { method: "POST", remoteAddress: "127.0.0.1", origin: "http://localhost:5190", host: "localhost:5190", contentType: "application/json" };
  assert.equal(refusal(ok), null);
  assert.equal(refusal({ ...ok, origin: undefined }), null);
  assert.match(refusal({ ...ok, remoteAddress: "192.168.1.20" }), /this computer/);
  assert.match(refusal({ ...ok, origin: "https://evil.example" }), /own page/);
  assert.match(refusal({ ...ok, contentType: "text/plain" }), /JSON/);
  assert.match(refusal({ ...ok, method: "GET" }), /POST/);
});

test("the whole check: prepare, statuses, scan, verdict per lead, saved copy", async () => {
  assert.equal(await engineAvailable(), true);
  const prepared = await prepare({ name: "Tampa owners", columns, rows: rows.map(row => ({ ...row })), outcomeColumn: "Call Status" });
  rows.forEach(row => assert.ok(value(row, "Owner")));
  const meanings = Object.fromEntries(prepared.statuses.map(item => [item.key, item.outcomes]));
  assert.deepEqual(meanings["wrong number"], ["wrong_number"]);
  assert.ok(meanings["interested"].includes("reached"));

  const stages = [];
  const outcomes = { column: "Call Status", map: meanings };
  const config = engineConfig(prepared.suggestion.config, columns, rows, mappings, { outcomes });
  const result = await check({ datasetId: prepared.datasetId, config, onStage: event => stages.push(event.stage) });
  assert.ok(stages.includes("checking_phones"), "progress reaches the page");
  assert.equal(result.results.length, rows.length, "one result per lead, in order");
  const verdicts = result.results.map(item => item.verdict);
  assert.equal(verdicts[4], "No phone");
  assert.equal(verdicts[1], "Wrong number");
  assert.equal(verdicts[3], "Wrong number", "a reserved 555-01xx number is not callable");
  assert.equal(verdicts[5], "Do not call");
  assert.ok(["Possible duplicate"].includes(verdicts[0]) || ["Possible duplicate"].includes(verdicts[2]), "the repeated owner is found");
  assert.equal(result.results[0].bestPhone, "+18132746610");

  const saved = await saveCopy({ datasetId: prepared.datasetId, config: result.config, jobId: result.jobId, name: "Tampa owners · checked" });
  assert.equal(saved.rows, rows.length);
});

test("a do-not-call row keeps its verdict even when it is also a repeat", () => {
  assert.equal(crmVerdict({ "Phone (verdict)": "wrong", "Phone (why)": "Do not call until 2027", "Best phone": "", "Duplicate status": "Keep" }), "Do not call");
  assert.equal(crmVerdict({ "Phone (verdict)": "corroborated", "Best phone": "+18132746610", "Best phone verdict": "corroborated" }), "Ready to call");
  assert.equal(crmVerdict({ Owner: "x" }), "No phone");
});

test("a list without phones: the engine finds the leads it repeats, and the owner's other property stays its own", async () => {
  const header = ["Id", "Address", "City", "State", "Zip", "Owner 1 First Name", "Owner 1 Last Name", "Owner Mailing Address"];
  const make = (id, values) => ({ id, sourceValues: Object.fromEntries(header.map((column, index) => [column, values[index]])) });
  const county = [
    make("a", ["1", "840 W 124TH ST", "LOS ANGELES", "CA", "90044", "VIRGINIA", "FRIZ", "721 W EL SEGUNDO BLVD"]),
    make("b", ["2", "840 W 124th Street", "Los Angeles", "CA", "90044", "Virginia", "Friz", "721 W EL SEGUNDO BLVD"]),
    make("c", ["3", "12 OAK AVE", "LOS ANGELES", "CA", "90045", "VIRGINIA", "FRIZ", "721 W EL SEGUNDO BLVD"]),
    make("d", ["4", "9 PINE RD", "GARDENA", "CA", "90247", "SAM", "HILL", "9 PINE RD"]),
  ];
  const found = { address: "Address", city: "City", region: "State", zip: "Zip", firstName: "Owner 1 First Name", lastName: "Owner 1 Last Name", mailingAddress: "Owner Mailing Address" };
  const prepared = await prepare({ name: "County", columns: header, rows: county });
  const config = engineConfig(prepared.suggestion.config, header, county, found, {});
  assert.deepEqual(config.phone_columns, []);
  assert.equal(config.mailing_address_column, "Owner Mailing Address");
  const result = await checkRepeats({ datasetId: prepared.datasetId, config });
  assert.equal(result.results.length, 4, "one result per lead, in order");
  const verdicts = result.results.map(item => item.verdict);
  assert.equal(verdicts.filter(verdict => verdict === "Possible duplicate").length, 1, "the same lead written twice is one repeat");
  assert.ok(verdicts[0] === "Possible duplicate" || verdicts[1] === "Possible duplicate");
  assert.equal(verdicts[2], "No phone", "the same owner's other property is its own lead");
  assert.match(result.results[2].why, /^Same owner as row/);
  assert.equal(verdicts[3], "No phone");
});

test("leads go on the map at their ZIP centre at once, offline, and a ZIP in another state is not trusted", async () => {
  const places = await zipPlaces([
    { id: "la", zip: "90044", region: "CA" },
    { id: "tampa", zip: "33602", region: "Florida" },
    { id: "wrong", zip: "90044", region: "TX" },
    { id: "none", zip: "", region: "CA" },
  ]);
  assert.equal(places.la.precision, "zip");
  assert.ok(Math.abs(places.la.lat - 33.95) < 0.05 && Math.abs(places.la.lng + 118.29) < 0.05);
  assert.ok(places.tampa, "a full state name is understood");
  assert.equal(places.wrong, undefined);
  assert.equal(places.none, undefined);
});

test("only leads with a street and a ZIP (or a city and state) are looked up", () => {
  assert.equal(stateCode("Florida"), "FL");
  assert.equal(stateCode("ca"), "CA");
  assert.equal(stateCode("Atlantis"), "");
  assert.equal(locatable({ address: "840 W 124TH ST", zip: "90044" }), true);
  assert.equal(locatable({ address: "840 W 124TH ST", city: "Los Angeles", region: "California" }), true);
  assert.equal(locatable({ address: "Address not supplied", zip: "90044" }), false);
  assert.equal(locatable({ address: "840 W 124TH ST" }), false);
});
