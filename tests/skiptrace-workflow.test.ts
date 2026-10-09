import { describe, expect, it } from "vitest";
import { checkedCopies, missingColumns, readDraft, stableKey, statusPage } from "../src/lib/skiptrace-workflow";
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
