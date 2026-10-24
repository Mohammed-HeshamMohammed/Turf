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

// A county-records export (PropStream style), the row the user imported.
const COUNTY_HEADER = ["Id", "Address", "City", "State", "Zip", "County", "Living Square Feet", "Year Built", "Lot (Acres)", "Lot (Square Feet)", "Land Use", "Property Type", "Property Use", "Subdivision", "APN", "Legal Description", "Units Count", "Bedrooms", "Bathrooms", "# of Stories", "Garage Type", "Garage Square Feet", "Carport", "Carport Area", "Air Conditioning Type", "Heating Type", "# of Fireplaces", "Owner 1 First Name", "Owner 1 Last Name", "Owner 2 First Name", "Owner 2 Last Name", "Owner 3 First Name", "Owner 3 Last Name", "Owner 4 First Name", "Owner 4 Last Name", "Owner Mailing Address", "Owner Mailing City", "Owner Mailing State", "Owner Mailing Zip", "Ownership Length (Months)", "Owner Type", "Owner Occupied", "Vacant?"];
const COUNTY_ROW = ["110462", "840 W 124TH ST", "LOS ANGELES", "CA", "90044", "Los Angeles", "2457", "1952", "0.2502066", "10899", "Residential", "Multi-Family 2-4 Units", "DUPLEX (2 UNITS, ANY COMBINATION)", "8", "6117-016-011", "TRACT NO 8O LOT 5 BLK K", "2", "5", "3", "1", "Type Not Specified", "0", "", "", "", "", "0", "VIRGINIA", "FRIZ", "", "", "KATHERINE", "AVARIA", "", "", "721 W EL SEGUNDO BLVD APT 6", "GARDENA", "CA", "90247", "227", "INDIVIDUAL", "", ""];

test("a county-records export maps every column the lead uses", async () => {
  const { leadFromSource } = await import("../src/skiptrace-fields.js");
  const row = { sourceValues: Object.fromEntries(COUNTY_HEADER.map((column, index) => [column, COUNTY_ROW[index]])) };
  const lead = leadFromSource(COUNTY_HEADER, row);
  assert.equal(lead.name, "VIRGINIA FRIZ");
  assert.deepEqual(lead.owners, ["VIRGINIA FRIZ", "KATHERINE AVARIA"], "the empty Owner 2 is not a person");
  assert.equal(lead.address, "840 W 124TH ST");
  assert.equal(lead.city, "LOS ANGELES");
  assert.equal(lead.county, "Los Angeles");
  assert.equal(lead.beds, 5);
  assert.equal(lead.baths, 3);
  assert.equal(lead.area, 2457);
  assert.equal(lead.yearBuilt, 1952);
  assert.equal(lead.lotAcres, 0.2502066);
  assert.equal(lead.lotSqft, 10899);
  assert.equal(lead.units, 2);
  assert.equal(lead.stories, 1);
  assert.equal(lead.propertyType, "Multi-Family 2-4 Units");
  assert.equal(lead.propertyUse, "DUPLEX (2 UNITS, ANY COMBINATION)");
  assert.equal(lead.landUse, "Residential");
  assert.equal(lead.parcel, "6117-016-011");
  assert.equal(lead.legal, "TRACT NO 8O LOT 5 BLK K");
  assert.equal(lead.subdivision, "8");
  assert.equal(lead.garageType, "Type Not Specified");
  assert.equal(lead.mailing, "721 W EL SEGUNDO BLVD APT 6, GARDENA, CA 90247");
  assert.equal(lead.ownershipMonths, 227);
  assert.equal(lead.ownerType, "INDIVIDUAL");
  assert.equal(lead.ownerOccupied, "");
  assert.equal(lead.vacant, "");
  assert.equal(lead.sourceId, "110462");
  assert.equal(lead.value, null, "no value column: no made-up $0");
  assert.equal(lead.phone, "");
});
