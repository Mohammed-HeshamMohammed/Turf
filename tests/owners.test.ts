import { describe, expect, it } from "vitest";
import { foundElsewhere, nameWords, otherOwners, ownerColumns, ownerFacts, ownerIndex, ownerKind, phoneKey } from "../src/lib/owners";
import type { Dataset, DatasetRow } from "../src/lib/types";

const row = (id: number, raw: Record<string, string>) => ({ id: String(id), row_number: id, raw }) as unknown as DatasetRow;
const list = (id: string, name: string) => ({ id, name, kind: "import" }) as unknown as Dataset;

describe("the kind of owner a name shows", () => {
  it.each([
    ["SMITH JOHN & MARY", "household"], ["John & Mary Smith", "household"], ["SMITH JOHN ETUX MARY", "household"], ["JOHN SMITH", "person"],
    ["Smith, John", "person"], ["GARCIA MARIA L", "person"], ["Nguyen Thi", "person"], ["Sitwell Housing LLC", "company"], ["ABC PROPERTIES INC", "company"],
    ["SMITH FAMILY TRUST", "trust"], ["JOHN SMITH TRUST", "trust"], ["DOE JANE TR", "trust"], ["ESTATE OF JOHN DOE", "estate"], ["Doe John Est", "estate"],
    ["HEIRS OF MARY LEE", "estate"], ["CITY OF HOUSTON", "government"], ["HOUSTON ISD", "government"], ["WELLS FARGO BANK NA", "bank"],
    ["FEDERAL NATIONAL MORTGAGE ASSOC", "bank"], ["West Lane Church", "company"], ["Westbrook Estes", "person"],
  ])("%s is a %s", (name, kind) => expect(ownerKind(name)).toBe(kind));

  it("reads names by their words, in any order", () => {
    expect([...nameWords("SMITH JOHN & MARY")].sort()).toEqual(["john", "mary", "smith"]);
    expect([...nameWords("Jane Doe Revocable Trust")].sort()).toEqual(["doe", "jane"]);
  });
});

describe("how the owner gets mail", () => {
  const columns = ownerColumns(["Owner", "Address", "City", "State", "Zip", "Mailing Address", "Mailing City", "Mailing State", "Mailing Zip"]);
  it("finds absentee and out-of-state owners and PO boxes", () => {
    const home = { Owner: "Ana Lopez", Address: "12 Main St", City: "Houston", State: "TX", Zip: "77009" };
    expect(ownerFacts(row(1, { ...home, "Mailing Address": "12 Main Street", "Mailing City": "Houston", "Mailing State": "TX", "Mailing Zip": "77009" }), columns))
      .toMatchObject({ kind: "person", absentee: false, outOfState: false, poBox: false });
    expect(ownerFacts(row(2, { ...home, "Mailing Address": "PO Box 77", "Mailing City": "Dallas", "Mailing State": "TX", "Mailing Zip": "75201" }), columns))
      .toMatchObject({ absentee: true, outOfState: false, poBox: true });
    expect(ownerFacts(row(3, { ...home, "Mailing Address": "9 Elm Rd", "Mailing City": "Tucson", "Mailing State": "AZ", "Mailing Zip": "85711" }), columns))
      .toMatchObject({ absentee: true, outOfState: true, mailing: "9 Elm Rd, Tucson, AZ 85711" });
  });
});

describe("contacts and owners in other lists", () => {
  const leadColumns = ownerColumns(["Owner", "Address", "Zip", "Mailing Address", "Mailing Zip", "Phone", "Email"]);
  const skipColumns = ownerColumns(["Owner", "Address", "Zip", "Mailing Address", "Mailing Zip", "Phone", "Email"]);
  const leads = [row(1, { Owner: "SMITH JOHN & MARY", Address: "12 Main St", Zip: "77009", "Mailing Address": "", "Mailing Zip": "", Phone: "", Email: "" }),
    row(2, { Owner: "Bo Reyes", Address: "40 Oak Ave", Zip: "77009", "Mailing Address": "500 Pine Rd", "Mailing Zip": "77010", Phone: "(713) 555-0100", Email: "" })];
  const skipped = [row(1, { Owner: "John Smith", Address: "12 Main Street", Zip: "77009", "Mailing Address": "", "Mailing Zip": "", Phone: "1-832-555-0199", Email: "JS@Example.com" }),
    row(2, { Owner: "Reyes Bo A", Address: "77 Far Ln", Zip: "77001", "Mailing Address": "500 Pine Road", "Mailing Zip": "77010", Phone: "713.555.0100; 281 555 0123", Email: "" }),
    row(3, { Owner: "Carla Diaz", Address: "40 Oak Avenue", Zip: "77009", "Mailing Address": "", "Mailing Zip": "", Phone: "346 555 0111", Email: "" })];
  const index = ownerIndex([{ dataset: list("a", "Leads"), rows: leads, columns: leadColumns }, { dataset: list("b", "Skip traced"), rows: skipped, columns: skipColumns }]);

  it("brings in the same owner's contacts by property or by mailing address, never ones the row has", () => {
    expect(foundElsewhere(leads[0], "a", leadColumns, index)).toEqual([
      { value: "8325550199", kind: "phone", list: "Skip traced", basis: "Same owner, same property", warning: undefined },
      { value: "js@example.com", kind: "email", list: "Skip traced", basis: "Same owner, same property" },
    ]);
    expect(foundElsewhere(leads[1], "a", leadColumns, index).map(item => item.value)).toEqual(["2815550123"]);
    expect(phoneKey("1 (713) 555-0100")).toBe("7135550100");
  });

  it("says when another list names a different owner for the same property", () => {
    expect(otherOwners(leads[1], "a", leadColumns, index)).toEqual([{ list: "Skip traced", owner: "Carla Diaz" }]);
    expect(otherOwners(leads[0], "a", leadColumns, index)).toEqual([]);
  });
});
