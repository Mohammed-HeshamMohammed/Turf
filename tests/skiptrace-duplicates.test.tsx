import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkiptraceDuplicates } from "../src/components/SkiptraceDuplicates";
import { isAddedColumn, ownColumns } from "../src/lib/marks";
import type { DuplicateSummary } from "../src/lib/types";

afterEach(cleanup);

const found: DuplicateSummary = {
  groups: 2,
  duplicate_rows: 3,
  rows_in_groups: 5,
  possible_rows: 1,
  owner_groups: 0,
  owner_rows: 0,
  examples: [
    {
      group: "D1",
      why: "Same phone, name and property address",
      size: 2,
      rows: [
        { row_number: 2, keep: true, label: "John Smith · 12 Main St · +17135550142" },
        { row_number: 9, keep: false, label: "JOHN SMITH · 12 Main Street · +17135550142" },
      ],
    },
  ],
  owner_examples: [],
  compared_pairs: 41,
  ignored_shared_values: 1,
  skipped_groups: 0,
  has_names: true,
  has_address: true,
};

describe("repeated leads in a phone check's results", () => {
  it("says how many rows repeat a lead, shows which row is kept, and opens the rows to review", async () => {
    const showRows = vi.fn();
    render(<SkiptraceDuplicates found={found} showRows={showRows} />);
    expect(screen.getByText("3 rows")).toBeTruthy();
    expect(screen.getByText(/leaves 3 fewer to call/)).toBeTruthy();
    expect(screen.getByText("John Smith · 12 Main St · +17135550142")).toBeTruthy();
    expect(screen.getByText("Keep")).toBeTruthy();
    expect(screen.getByText(/1 number or email is on many rows under different names/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Leads written more than once/ }));
    await userEvent.click(screen.getByRole("button", { name: /Row that might repeat another/ }));
    expect(showRows.mock.calls).toEqual([["duplicates"], ["possible_duplicates"]]);
    // Nothing to open where nothing was found.
    expect((screen.getByRole("button", { name: /Owners with several properties/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says so plainly when no row repeats another, when it is turned off, and nothing for a check from before", () => {
    const { rerender, container } = render(
      <SkiptraceDuplicates found={{ ...found, groups: 0, duplicate_rows: 0, rows_in_groups: 0, possible_rows: 0, examples: [] }} showRows={() => undefined} />,
    );
    expect(screen.getByText("No row repeats another.")).toBeTruthy();
    rerender(<SkiptraceDuplicates found={null} showRows={() => undefined} />);
    expect(screen.getByText(/turned off for this list/)).toBeTruthy();
    rerender(<SkiptraceDuplicates found={undefined} showRows={() => undefined} />);
    expect(container.textContent).toBe("");
  });

  it("keeps the duplicate columns apart from the list's own columns", () => {
    expect(["Duplicate group", "Duplicate status", "Duplicate why", "Same owner rows"].every(isAddedColumn)).toBe(true);
    expect(ownColumns(["Owner", "Duplicate status", "Phone"])).toEqual(["Owner", "Phone"]);
  });
});
