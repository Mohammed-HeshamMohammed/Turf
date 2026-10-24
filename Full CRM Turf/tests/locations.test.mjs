import test from "node:test";
import assert from "node:assert/strict";
import { coordinates, mappedRecord, sourceEvidence } from "../src/skiptrace-fields.js";
import { recordLocation, mapSearchUrl } from "../src/locations.js";
import { reducer, visibleLeads } from "../src/model.js";
import { seedState } from "../src/data.js";

test("coordinates accept zero and international points, reject blanks, partial and invalid pairs", () => {
  assert.deepEqual(coordinates(0, 0), [0, 0]);
  assert.deepEqual(coordinates("-33.8688", "151.2093"), [-33.8688, 151.2093]);
  for (const pair of [
    ["", ""],
    [null, null],
    [91, 0],
    [0, -181],
    [28, ""],
    ["NaN", 12],
    [Infinity, 0],
  ])
    assert.equal(coordinates(...pair), null);
});

test("maps separate supplied coordinates, approximate areas, address-only and missing locations", () => {
  assert.equal(recordLocation({ latitude: 0, longitude: 0, address: "Test" }).kind, "coordinates");
  assert.equal(recordLocation({ city: "Tampa", region: "FL" }).kind, "area");
  assert.equal(recordLocation({ city: "Tampa", region: "Other" }).point, null);
  assert.equal(recordLocation({ city: "Tampa", region: "FL", country: "AU" }).point, null);
  assert.equal(recordLocation({ city: "constructor", region: "FL" }).point, null);
  assert.equal(recordLocation({ address: "10 Main St", city: "Unknown city" }).kind, "address");
  assert.equal(recordLocation({ name: "Only a name", address: "Address not supplied" }).kind, "missing");
  assert.equal(recordLocation({ latitude: 999, longitude: 1 }).invalid, true);
  assert.equal(recordLocation({ latitude: 0, longitude: "" }).invalid, true);
  assert.equal(recordLocation({ zip: "90210" }).point, null);
  assert.equal(mapSearchUrl(recordLocation({})), null);
  assert.match(mapSearchUrl(recordLocation({ address: "10 Main & Oak" })), /Main%20%26%20Oak/);
});

test("split names and addresses, international fields and coordinates detect without phone evidence", () => {
  const sourceValues = {
    FirstName: "Alex",
    LastName: "Rivera",
    HouseNumber: "12",
    StreetName: "Oak Road",
    Province: "NSW",
    Postcode: "2000",
    Country: "AU",
    Lat: "-33.8688",
    Lng: "151.2093",
    MailingAddress: "PO Box 4",
    CallOutcome: "Wrong number",
    Extra: "kept",
  };
  const columns = Object.keys(sourceValues);
  const data = mappedRecord(columns, { sourceValues });
  assert.equal(data.name, "Alex Rivera");
  assert.equal(data.address, "12 Oak Road");
  assert.equal(data.mailingAddress, "PO Box 4");
  assert.equal(data.region, "NSW");
  assert.equal(data.zip, "2000");
  assert.equal(data.outcome, "Wrong number");
  assert.equal(sourceEvidence(columns, [{ sourceValues }]).primary.id, "address");
  assert.equal(sourceEvidence(["Lat", "Lng"], [{ sourceValues }]).primary.id, "coordinates");
  assert.deepEqual(recordLocation({ sourceValues }, { columns }).point, [-33.8688, 151.2093]);
  assert.equal(sourceValues.Extra, "kept");
});

test("mailing-only input is never treated as a property location", () => {
  const row = { sourceValues: { MailingAddress: "10 Postal Road", MailingCity: "Tampa", MailingState: "FL" } };
  assert.equal(recordLocation(row, { columns: Object.keys(row.sourceValues) }).kind, "missing");
});

test("manual coordinate mapping persists per source and never changes blocked status or original values", () => {
  const state = seedState();
  state.role = "researcher";
  const row = state.leads.find(item => item.datasetId === "d01");
  row.verdict = "Do not call";
  row.sourceValues = { Owner: "Alex", Northing: "28", Easting: "-82", Notes: "Original" };
  state.datasets.find(item => item.id === "d01").columns = Object.keys(row.sourceValues);
  const next = reducer(state, {
    type: "SOURCE_MAPPING",
    id: "d01",
    mappings: { latitude: "Northing", longitude: "Easting", name: "Owner", email: "invented" },
  });
  const updated = next.leads.find(item => item.id === row.id);
  assert.equal(updated.verdict, "Do not call");
  assert.deepEqual(updated.sourceValues, row.sourceValues);
  assert.deepEqual(
    recordLocation(
      updated,
      next.datasets.find(item => item.id === "d01"),
    ).point,
    [28, -82],
  );
  assert.equal(next.datasets.find(item => item.id === "d01").fieldMappings.email, "");
  assert.deepEqual(
    next.datasets.find(item => item.id === "d02"),
    state.datasets.find(item => item.id === "d02"),
  );
  assert.equal(reducer({ ...state, role: "client" }, { type: "SOURCE_MAPPING", id: "d01", mappings: {} }).datasets, state.datasets);
  assert.ok(visibleLeads({ ...state, role: "client" }).every(item => item.shared));
});
