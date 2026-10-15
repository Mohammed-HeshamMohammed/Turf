import test from "node:test";
import assert from "node:assert/strict";
import { sourceEvidence, sourceValue } from "../src/skiptrace-fields.js";

test("uses a real populated phone field first, including common header variants", () => {
  const evidence = sourceEvidence(
    ["Owner_Name", "Property Address", "Mobile 1"],
    [{ sourceValues: { Owner_Name: "Sarah", "Property Address": "10 Main St", "Mobile 1": "+1 813 555 0101" } }],
  );
  assert.equal(evidence.primary.id, "phone");
  assert.equal(evidence.primary.column, "Mobile 1");
  assert.equal(sourceEvidence(["Owner1PhoneNumber"], [{ sourceValues: { Owner1PhoneNumber: "8135550101" } }]).primary.id, "phone");
  assert.equal(sourceEvidence(["PropertyAddressLine1"], [{ sourceValues: { PropertyAddressLine1: "10 Main St" } }]).primary.id, "address");
});

test("falls back through address, email and name without inventing phone columns", () => {
  const row = { sourceValues: { Address: "10 Main St", Email: "sarah@example.test", Owner: "Sarah" } };
  for (const [columns, expected] of [
    [["Address", "Email", "Owner"], "address"],
    [["Email", "Owner"], "email"],
    [["Owner"], "name"],
  ]) {
    const evidence = sourceEvidence(columns, [row]);
    assert.equal(evidence.primary.id, expected);
    assert.equal(evidence.fields[0].column, "");
  }
});

test("blank phone columns fall back and another populated phone column takes precedence", () => {
  const row = { sourceValues: { Phone: "N/A", Address: "10 Main St", "Phone 2": "8135550101" } };
  assert.equal(sourceEvidence(["Phone", "Address"], [row]).primary.id, "address");
  assert.equal(sourceEvidence(["Phone", "Phone 2", "Address"], [row]).primary.column, "Phone 2");
});

test("manual mappings use original values and stale columns cannot carry into another source", () => {
  const row = { sourceValues: { Location: "10 Main St" } };
  assert.equal(sourceEvidence(["Location"], [row]).primary, null);
  assert.equal(sourceEvidence(["Location"], [row], { address: "Location" }).primary.id, "address");
  assert.equal(sourceValue(row, "Location"), "10 Main St");
  assert.equal(sourceEvidence(["Notes"], [row], { address: "Location" }).primary, null);
});

test("unusable or empty input requires mapping and legacy source records still work", () => {
  assert.equal(sourceEvidence([], []).primary, null);
  assert.equal(sourceEvidence(["Address"], [{ address: "Address not supplied" }]).primary, null);
  assert.equal(sourceEvidence(["Phone", "Address"], [{ phone: "", address: "10 Main St" }]).primary.id, "address");
});
