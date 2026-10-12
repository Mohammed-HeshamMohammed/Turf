import { describe, expect, it } from "vitest";
import { callProgress, contactCoverage, mailColumnsOf, nextSteps, phoneColumnsOf, progressKind, reachContext, reachOf, shareText, statusKey } from "../src/lib/dashboard";
import type { Dataset, DatasetRow, SkiptraceSuggestion, StatusRow } from "../src/lib/types";

const row = (id: number, raw: Record<string, string>) => ({ id: String(id), row_number: id, raw }) as unknown as DatasetRow;
const status = (key: string, outcomes: string[], confirmed: boolean, count: number) => ({ key, example: key, count, outcomes, confirmed }) as unknown as StatusRow;
const list = (id: string, name: string) => ({ id, name, kind: "import" }) as unknown as Dataset;

describe("what the Dashboard tells from a list on its own", () => {
  it("counts rows that can be reached by phone or email, without a phone check", () => {
    const rows = [row(1, { Phone: "(713) 555-3142", "Alt. Phone": "832-555-1111", Email: "" }), row(2, { Phone: "n/a", "Alt. Phone": "", Email: "a@b.co" }), row(3, { Phone: "", "Alt. Phone": "", Email: "" })];
    const columns = ["Phone", "Alt. Phone", "Email"];
    expect(contactCoverage(rows, columns, phoneColumnsOf(columns))).toEqual({ phone: 1, severalPhones: 1, email: 1, neither: 1 });
    const setup = { config: { phone_columns: ["Phone"] } } as unknown as SkiptraceSuggestion;
    expect(phoneColumnsOf(columns, setup)).toEqual(["Phone"]);
  });

  it("reads call results by what each status means, settled by Turf or by the person", () => {
    expect(progressKind(status("dnc: interested", ["do_not_call", "reached"], false, 1))).toBe("do_not_call");
    expect(progressKind(status("wrong person", ["wrong_person"], true, 1))).toBe("bad_number");
    expect(progressKind(status("not yet reached", [], true, 1))).toBe("no_result");
    expect(progressKind(status("owner in hospital", [], false, 1))).toBe("unclear");
    const setup = { outcome_column: "Status", rows: 100, statuses: [status("interested", ["reached"], true, 10), status("lvm", ["voicemail"], true, 20), status("dnc: sold", ["do_not_call", "reached"], false, 5), status("odd", [], false, 2)] } as unknown as SkiptraceSuggestion;
    expect(callProgress(setup)).toEqual({ reached: 10, no_pickup: 20, bad_number: 0, do_not_call: 5, unclear: 2, no_result: 63, column: "Status", statusesNeedingYou: 2, rowsNeedingYou: 7 });
    expect(callProgress({ ...setup, outcome_column: null })).toBeNull();
  });

  it("puts the biggest next step first", () => {
    const progress = { reached: 0, no_pickup: 0, bad_number: 0, do_not_call: 0, unclear: 0, no_result: 0, column: "Status", statusesNeedingYou: 3, rowsNeedingYou: 900 };
    const steps = nextSteps([
      { dataset: list("a", "March"), rows: 5000, checked: false, phoneRows: 4000, zipColumn: "Zip", zipless: 0, progress },
      { dataset: list("b", "April"), rows: 200, checked: true, phoneRows: 200, zipColumn: undefined, zipless: 200, progress: null },
    ]);
    expect(steps.map(step => step.text)).toEqual(["Check the phones in March", "3 call statuses in March need you", "April has no ZIP column"]);
    expect(steps[0]).toMatchObject({ tab: "skiptracing", datasetId: "a" });
    expect(nextSteps([{ dataset: list("c", "Done"), rows: 10, checked: true, phoneRows: 10, zipColumn: "Zip", zipless: 0, progress: null }])).toEqual([]);
  });

  it("keys a status the way the service does, so its meaning is found for every row", () => {
    expect(statusKey("  DNC until 10/07/2025:Not   interested ")).toBe("dnc until [date]:not interested");
    expect(statusKey("Expires 2025-10-15")).toBe("expires [date]");
    expect(statusKey(null)).toBe("");
  });

  it("puts each row in one way of reaching it, do not call first", () => {
    const columns = ["Phone", "Email", "Mailing Address", "Status"];
    const setup = { outcome_column: "Status", config: { phone_columns: ["Phone"] }, rows: 0,
      statuses: [status("dnc", ["do_not_call"], true, 1), status("wrong number", ["wrong_number"], true, 1)] } as unknown as SkiptraceSuggestion;
    const context = reachContext(columns, setup);
    expect(mailColumnsOf(columns)).toEqual(["Mailing Address"]);
    const raw = (values: Record<string, string>) => row(1, { Phone: "", Email: "", "Mailing Address": "", Status: "", ...values });
    expect(reachOf(raw({ Phone: "7135553142", Status: "DNC" }), context, null)).toBe("blocked");
    expect(reachOf(raw({ Phone: "7135553142", Status: "Wrong number" }), context, null)).toBe("blocked");
    expect(reachOf(raw({ Phone: "7135553142" }), context, null)).toBe("phone");
    expect(reachOf(raw({ Phone: "7135553142" }), context, true)).toBe("ready");
    expect(reachOf(raw({ Phone: "7135553142" }), context, false)).toBe("blocked");
    expect(reachOf(raw({ Email: "a@b.co" }), context, null)).toBe("email");
    expect(reachOf(raw({ "Mailing Address": "12 Main St" }), context, null)).toBe("mail");
    expect(reachOf(raw({}), context, null)).toBe("none");
    const checked = reachContext(columns, setup, email => email !== "a@b.co");
    expect(reachOf(raw({ Email: "a@b.co", "Mailing Address": "12 Main St" }), checked, null)).toBe("mail");
    expect(reachOf(raw({ Email: "a@b.co; c@d.co" }), checked, null)).toBe("email");
  });

  it("never shows a small share as 0%", () => {
    expect(shareText(24, 7557)).toBe("<1%");
    expect(shareText(0, 7557)).toBe("0%");
    expect(shareText(484, 813)).toBe("60%");
  });
});
