import assert from "node:assert/strict";
import test from "node:test";
import { demoLeads, toCsv } from "../scripts/demo-leads.mjs";

test("200 made-up leads with unique numbers in unassigned 555 ranges", () => {
  const rows = demoLeads(200);
  assert.equal(rows.length, 200);
  assert.equal(new Set(rows.map(row => row.phone)).size, 200);
  for (const row of rows) assert.match(row.phone, /^\+1(813|727|941|352)555\d{4}$/);
});

test("the story leads come first, one per simulator outcome", () => {
  const suffixes = demoLeads(200).slice(0, 10).map(row => row.phone.slice(-4));
  assert.deepEqual(suffixes, ["0001", "0002", "0003", "0004", "0005", "0007", "0009", "0010", "0011", "0013"]);
});

test("every other lead is answered by a person: no scenario matches its last four digits", () => {
  const scenarioSuffixes = ["0001", "0002", "0003", "0004", "0005", "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013"];
  for (const row of demoLeads(200).slice(10)) assert.equal(scenarioSuffixes.includes(row.phone.slice(-4)), false, row.phone);
});

test("the CSV has a header and quotes fields with commas", () => {
  const csv = toCsv([{ name: "Ana Diaz", phone: "+18135550001", address: "12 Bay St, Unit 4", city: "Tampa", state: "FL", zip: "33602", motivation: "Inherited" }]);
  const [header, line] = csv.trim().split("\n");
  assert.equal(header, "Owner Name,Phone,Property Address,City,State,ZIP,Motivation");
  assert.equal(line, 'Ana Diaz,+18135550001,"12 Bay St, Unit 4",Tampa,FL,33602,Inherited');
});
