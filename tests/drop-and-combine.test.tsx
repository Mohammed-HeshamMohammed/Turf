import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Turf } from "../src/App";
import { CombineLists } from "../src/components/CombineLists";
import { DropImport } from "../src/components/DropImport";
import type { CombineSummary } from "../src/lib/service";
import type { Dataset } from "../src/lib/types";

const service = vi.hoisted(() => {
  class ServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  class AlreadyHere extends ServiceError {
    already: unknown;
    constructor(already: { name: string }) {
      super("already_here", `The same rows are already in the project, as “${already.name}”. It was not added again.`);
      this.already = already;
    }
  }
  return {
    AlreadyHere,
    importContent: vi.fn(),
    importFile: vi.fn(),
    compareLists: vi.fn(),
    combineLists: vi.fn(),
    overrule: vi.fn(async () => []),
  };
});
vi.mock("../src/lib/service", () => ({
  ...service,
  inDesktop: false,
  describeLeftOut: () => "",
  describeOverlaps: (imported: { overlaps?: { name: string }[] }) =>
    imported.overlaps?.length ? `Some of its rows are also in “${imported.overlaps[0].name}”.` : "",
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const project = { id: "p", name: "Houston", root_path: "C:/p", created_at: "" };
const dropped = (...names: string[]) => ({ dataTransfer: { types: ["Files"], files: names.map(name => new File(["a,b\n1,2\n"], name)) } });

describe("dropping a list's file anywhere on the window", () => {
  it("says where the file will go while it is held over the window, then adds it", async () => {
    service.importContent.mockResolvedValue({ dataset_id: "new", row_count: 40, overlaps: [{ name: "March" }] });
    const onAdded = vi.fn(async () => undefined);
    render(<DropImport project={project} onAdded={onAdded} />);
    fireEvent.dragEnter(window, dropped("april.csv"));
    expect(screen.getByText("Drop to add to Houston")).toBeTruthy();
    fireEvent.drop(window, dropped("april.csv"));
    expect(await screen.findByText(/Added, 40 rows\. Some of its rows are also in “March”\./)).toBeTruthy();
    expect(screen.queryByText("Drop to add to Houston")).toBeNull();
    expect(onAdded).toHaveBeenCalledWith("new");
    expect(service.importContent.mock.calls[0][1]).toBe(false);
  });

  it("does not add a list that is already here, unless the person asks for it all the same", async () => {
    service.importContent.mockRejectedValueOnce(new service.AlreadyHere({ name: "March" })).mockResolvedValueOnce({ dataset_id: "again", row_count: 40 });
    const onAdded = vi.fn(async () => undefined);
    render(<DropImport project={project} onAdded={onAdded} />);
    fireEvent.drop(window, dropped("march renamed.xlsx"));
    expect(await screen.findByText(/already in the project, as “March”/)).toBeTruthy();
    expect(onAdded).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Add it all the same" }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("again"));
    expect(service.importContent.mock.calls[1][1]).toBe(true);
  });

  it("adds several files one after another, and says so when no project is open", async () => {
    service.importContent.mockResolvedValue({ dataset_id: "x", row_count: 1 });
    const { rerender } = render(<DropImport project={project} onAdded={async () => undefined} />);
    fireEvent.drop(window, dropped("a.csv", "b.csv"));
    await waitFor(() => expect(service.importContent).toHaveBeenCalledTimes(2));
    rerender(<DropImport project={null} onAdded={async () => undefined} />);
    fireEvent.drop(window, dropped("c.csv"));
    expect(await screen.findByText(/Open or create a project first/)).toBeTruthy();
    expect(service.importContent).toHaveBeenCalledTimes(2);
  });
});

const list = (id: string, name: string, kind = "import") => ({ id, name, kind, row_count: 4 }) as unknown as Dataset;
const summary: CombineSummary = {
  mode: "all",
  lists: [
    { dataset_id: "a", name: "County roll", rows: 4, leads: 4, only_here: 1, elsewhere: 3 },
    { dataset_id: "b", name: "Traced", rows: 4, leads: 4, only_here: 1, elsewhere: 3 },
  ],
  counts: { all: 5, shared: 3, in_all: 3, only: [1, 1] },
  rows_in: 8,
  rows_out: 5,
  repeats_within: 0,
  examples: [
    {
      why: "Same property address and name",
      size: 2,
      rows: [
        { dataset_id: "b", list: "Traced", row_number: 2, label: "John Smith · 12 Main St" },
        { dataset_id: "a", list: "County roll", row_number: 2, label: "SMITH JOHN A · 12 Main Street" },
      ],
    },
  ],
  possible: [],
  possible_pairs: 0,
  compared_pairs: 3,
  overruled: 0,
};

describe("combining lists into one", () => {
  const turf = () =>
    ({
      datasets: [list("a", "County roll"), list("b", "Traced"), list("c", "Traced (phones checked)", "checked")],
      selectedId: "a",
      refresh: vi.fn(async () => undefined),
    }) as unknown as Turf;

  it("compares the chosen lists, says what they share, and saves what the person chose", async () => {
    service.compareLists.mockResolvedValue(summary);
    service.combineLists.mockResolvedValue({ dataset_id: "made", rows: 1, columns: 8, summary });
    const onDone = vi.fn();
    render(<CombineLists turf={turf()} onDone={onDone} onCancel={() => undefined} />);
    // A checked copy is not offered: its list is, and the check is used with it.
    expect(screen.queryByText(/phones checked/)).toBeNull();
    const compare = screen.getByRole("button", { name: "Compare them" }) as HTMLButtonElement;
    expect(compare.disabled).toBe(true);
    await userEvent.click(screen.getByRole("checkbox", { name: /Traced/ }));
    await userEvent.click(compare);
    expect(await screen.findByText("8 rows are 5 leads.")).toBeTruthy();
    expect(service.compareLists.mock.calls[0][0]).toEqual(["a", "b"]);
    expect(screen.getByRole("button", { name: "Save 5 rows as a new list" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /What it holds/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Leads only “County roll” has (1)" }));
    await userEvent.click(screen.getByRole("button", { name: "Save 1 rows as a new list" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("made"));
    expect(service.combineLists.mock.calls[0].slice(0, 3)).toEqual([["a", "b"], "only:a", ""]);
  });

  it("takes the person's word that two rows are not the same lead, and compares again", async () => {
    service.compareLists.mockResolvedValue(summary);
    render(<CombineLists turf={turf()} onDone={() => undefined} onCancel={() => undefined} />);
    await userEvent.click(screen.getByRole("checkbox", { name: /Traced/ }));
    await userEvent.click(screen.getByRole("button", { name: "Compare them" }));
    await userEvent.click(await screen.findByText(/leads found in more than one list/));
    await userEvent.click(screen.getByRole("button", { name: "Not the same lead" }));
    await waitFor(() => expect(service.compareLists).toHaveBeenCalledTimes(2));
    expect(service.overrule).toHaveBeenCalledWith("b", 2, 2, false, "a");
  });
});
