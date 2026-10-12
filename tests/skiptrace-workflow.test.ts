import { describe, expect, it } from "vitest";
import { checkedCopies, missingColumns, namesMapped, readDraft, refreshReadings, reviewNote, settledKeys, signEvidence, signReadiness, stableKey, statusPage } from "../src/lib/skiptrace-workflow";
import type { Dataset, SkiptraceConfig } from "../src/lib/types";

const config: SkiptraceConfig = { phone_columns: ["Phone"], region: "US", country_column: null, first_name_column: null, last_name_column: null, name_column: "Name", zip_column: null, state_column: null, signals: {}, outcome: { column: "Status", called_column: "Phone", map: { ignored: [] } } };

describe("complete and reusable setup", () => {
  it("reports every missing mapping instead of silently dropping it", () => {
    expect(missingColumns(config, ["Phone"])).toEqual(["Name", "Status"]);
    expect(missingColumns(config, ["Phone", "Name", "Status"])).toEqual([]);
    expect(missingColumns({ ...config, mailing_city_column: "Mailing City", vacancy_column: "Vacant?", additional_owners: [{ name_column: "Owner 2", mailing_zip_column: "Owner 2 Zip" }] }, ["Phone", "Name", "Status"])).toEqual(["Vacant?", "Mailing City", "Owner 2", "Owner 2 Zip"]);
  });
  it("keeps every status reachable across pages and search", () => {
    const statuses = Array.from({ length: 101 }, (_, i) => ({ key: `status ${i}`, example: `Status ${i}`, count: 1, outcomes: [] }));
    const pages = Array.from({ length: 6 }, (_, i) => statusPage(statuses, "", false, [], i).rows).flat();
    expect(pages).toEqual(statuses);
    expect(statusPage(statuses, "Status 100", false, [], 9).rows).toEqual([statuses[100]]);
    expect(statusPage(statuses, "", true, ["status 100"], 5).total).toBe(100);
  });
  it("moves a decided status to the bottom so the next one rises", () => {
    const statuses = ["a", "b", "c"].map(key => ({ key, example: key, count: 1 })) as Parameters<typeof statusPage>[0];
    expect(statusPage(statuses, "", false, [], 0).rows.map(row => row.key)).toEqual(["a", "b", "c"]);
    expect(statusPage(statuses, "", false, ["a"], 0).rows.map(row => row.key)).toEqual(["b", "c", "a"]);
    expect(statusPage(statuses, "", false, ["a", "b", "c"], 0).rows.map(row => row.key)).toEqual(["a", "b", "c"]);
    expect(statusPage(statuses, "", false, ["c", "a"], 0).rows.map(row => row.key)).toEqual(["b", "c", "a"], "the last one settled is last");
  });
  it("adds what the service settled unless the person chose otherwise", () => {
    const table = [
      { key: "interested", example: "Interested", count: 3, outcomes: ["reached"], confirmed: true, sure: true, source: "rules" },
      { key: "dnc: sold", example: "DNC: sold", count: 1, outcomes: ["do_not_call", "reached"], confirmed: false, sure: false, source: "rules", why: "Starts with DNC" },
    ] as Parameters<typeof settledKeys>[0];
    expect(settledKeys(table)).toEqual(["interested"]);
    expect(settledKeys(table, { interested: ["do_not_call"] })).toEqual([]);
    expect(reviewNote(table[0], true, ["reached"])).toEqual({ label: "Automatic", detail: "Every word is known dialer wording", needs: false });
    expect(reviewNote(table[1], false, ["do_not_call", "reached"])).toEqual({ label: "Needs you", detail: "Starts with DNC", needs: true });
    expect(reviewNote(table[1], true, ["reached"]).label).toBe("Reviewed");
    expect(reviewNote({ ...table[0], source: "memory", why: "You chose this on “A”" }, true, ["reached"]).label).toBe("You chose this on “A”");
  });
  it("takes newer readings without undoing what the person settled or changed", () => {
    type Row = Parameters<typeof refreshReadings>[0][number];
    const row = (key: string, outcomes: string[], confirmed: boolean) => ({ key, example: key, count: 1, outcomes, confirmed }) as unknown as Row;
    const before = [row("lvm", ["voicemail"], true), row("odd words", [], false), row("hung up on", [], false), row("mine", ["reached"], false)];
    const after = [row("lvm", ["voicemail"], true), row("odd words", ["reached"], true), row("hung up on", ["reached"], false), row("mine", ["no_answer"], false)];
    const next = refreshReadings(before, after, { lvm: ["voicemail"], "odd words": [], "hung up on": ["do_not_call"], mine: ["reached"] } as never, ["lvm", "mine"]);
    expect(next.meaning).toEqual({ lvm: ["voicemail"], "odd words": ["reached"], "hung up on": ["do_not_call"], mine: ["reached"] });
    expect(next.reviewed).toEqual(["lvm", "mine", "odd words"]);
    // a draft from the earlier version: what equals the earlier suggestion gives way, changes stay
    const earlier = [row("lvm", [], true), row("interested", ["reached"], true)];
    const today = [row("lvm", ["voicemail"], true), row("interested", ["reached"], true)];
    const upgraded = refreshReadings(earlier, today, { lvm: [], interested: ["do_not_call"] } as never, ["lvm", "interested"]);
    expect(upgraded.meaning).toEqual({ lvm: ["voicemail"], interested: ["do_not_call"] });
    expect(upgraded.reviewed).toEqual(["lvm", "interested"]);
  });
  it("says whether each warning sign can work and what the list's calls showed", () => {
    const config = { phone_columns: ["Phone"], first_name_column: "First", state_column: null, zip_column: "Zip", country_column: null } as unknown as Parameters<typeof signReadiness>[1];
    expect(signReadiness("shared_number", config)).toEqual({ ready: true, text: "Compares First" });
    expect(signReadiness("area_code_other_state", config).ready).toBe(false);
    expect(signReadiness("country_mismatch", config).text).toBe("Compares the phone's country with Zip");
    expect(signReadiness("business_line", config).ready).toBe(true);
    const sign = { code: "area_code_other_state", label: "", contacted: 120, wrong: 30, wrong_rate: 0.25, lift: 2.1, counted: true, measured_only: false, predictive: true, enough_data: true };
    expect(signEvidence(sign, true)).toEqual({ text: "In this list it predicts wrong numbers: 2.1× as often", on: true });
    expect(signEvidence({ ...sign, predictive: false, lift: 1 }, true).on).toBe(false);
    expect(signEvidence({ ...sign, enough_data: false, contacted: 12 }, true)).toEqual({ text: "Only 12 called numbers have a clear result; about 50 are needed to tell" });
    expect(signEvidence(undefined, true).on).toBeUndefined();
    expect(signEvidence(sign, false).text).toBe("Can't be measured: this list has no call results");
  });
  it("knows whether the called phone's owner has a name column", () => {
    const base = { phone_columns: ["P1", "P2"], first_name_column: "First", additional_owners: [{ name_column: null }], phone_owner_map: { P1: 0, P2: 1 } } as unknown as Parameters<typeof namesMapped>[0];
    expect(namesMapped(base, "P1")).toBe(true);
    expect(namesMapped(base, "P2")).toBe(false);
  });
  it("chooses the latest copy regardless of dataset ordering", () => {
    const older = { id: "old", parent_dataset_id: "parent", kind: "checked", created_at: "2026-01-01" } as Dataset;
    const newer = { ...older, id: "new", created_at: "2026-02-01" };
    expect(checkedCopies([older, newer], "parent").map(row => row.id)).toEqual(["new", "old"]);
  });
  it("does not mark unchanged settings stale because object keys were reordered", () => {
    expect(stableKey({ region: "US", outcome: { map: { b: [], a: ["reached"] } } })).toBe(stableKey({ outcome: { map: { a: ["reached"], b: [] } }, region: "US" }));
    expect(stableKey(["Phone", "Alt"])).not.toBe(stableKey(["Alt", "Phone"]));
  });
  it("restores project/list drafts and safely rejects damaged storage", () => {
    localStorage.clear();
    const state = { base: config, outcomeColumn: "Status", called: "Phone", meaning: { ignored: [] }, reviewed: ["ignored"], step: 2, copyName: "Reviewed", report: null, scannedWith: null };
    localStorage.setItem("project-a:list-a", JSON.stringify({ version: 1, state }));
    expect(readDraft("project-a:list-a")).toEqual(state);
    expect(readDraft("project-b:list-a")).toBeNull();
    localStorage.setItem("broken", "{");
    expect(readDraft("broken")).toBeNull();
  });
});
