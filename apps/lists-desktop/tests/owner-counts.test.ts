import { describe, expect, it } from "vitest";
import { addOwners, countOwners, emptyOwnerCounts, emptyOwnerIndex, ownerColumns, ownerIndex, type OwnerList } from "../src/lib/owners";
import type { Dataset, DatasetRow } from "../src/lib/types";

const row = (id: number, raw: Record<string, string>) => ({ id: String(id), row_number: id, raw }) as unknown as DatasetRow;
const list = (id: string, name: string, rows: DatasetRow[]): OwnerList => ({
  dataset: { id, name, kind: "import" } as unknown as Dataset,
  rows,
  columns: ownerColumns(Object.keys(rows[0].raw)),
});

const leads = list("leads", "Leads", [
  row(1, { Owner: "John Smith", Address: "12 Main St", Zip: "77008", "Mailing Address": "12 Main St", "Mailing Zip": "77008", Phone: "", Email: "" }),
  row(2, {
    Owner: "Lone Star Holdings LLC",
    Address: "40 Oak Ave",
    Zip: "77008",
    "Mailing Address": "PO Box 9",
    "Mailing Zip": "85004",
    Phone: "",
    Email: "x@mailinator.com",
  }),
  row(3, {
    Owner: "Estate of Ann Lee",
    Address: "7 Elm St",
    Zip: "77002",
    "Mailing Address": "900 Pine Rd",
    "Mailing Zip": "77002",
    Phone: "7135550101",
    Email: "",
  }),
  row(4, { Owner: "Mary Jones", Address: "5 Cedar Ln", Zip: "77002", "Mailing Address": "5 Cedar Ln", "Mailing Zip": "77002", Phone: "", Email: "" }),
]);
const county = list("county", "County roll", [
  row(1, { Owner: "SMITH JOHN", Address: "12 Main Street", Zip: "77008", Phone: "(713) 555-0199", Email: "john@example.com" }),
  row(2, { Owner: "Baker Tom", Address: "5 Cedar Lane", Zip: "77002", Phone: "", Email: "" }),
]);
const emailOk = (email: string) => !email.endsWith("mailinator.com");

describe("what the owners show, counted", () => {
  it("counts each row once: kinds, mail, unusable emails, and what another list has", () => {
    const lists = [leads, county];
    const index = ownerIndex(lists);
    const counts = emptyOwnerCounts();
    for (const item of lists) countOwners(counts, item, index, emailOk);
    expect(counts).toMatchObject({ named: 6, absentee: 2, poBox: 1, badEmails: 1, phoneElsewhere: 1, emailElsewhere: 1, ownerDiffers: 2 });
    expect(counts.kinds).toMatchObject({ person: 4, company: 1, estate: 1 });
    expect(counts.perList).toEqual({ leads: 1 });
  });

  it("gives the same answer read in turns as read at once, so a long list can be counted without holding the window up", () => {
    const lists = [leads, county];
    const whole = ownerIndex(lists);
    const inTurns = emptyOwnerIndex();
    for (const item of lists) for (let from = 0; from < item.rows.length; from += 1) addOwners(inTurns, item, from, from + 1);
    expect(inTurns).toEqual(whole);

    const atOnce = emptyOwnerCounts();
    const stepped = emptyOwnerCounts();
    for (const item of lists) {
      countOwners(atOnce, item, whole, emailOk);
      for (let from = 0; from < item.rows.length; from += 3) countOwners(stepped, item, inTurns, emailOk, from, from + 3);
    }
    expect(stepped).toEqual(atOnce);
  });
});
